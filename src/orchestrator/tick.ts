import { randomUUID } from 'node:crypto';

import { createCandidatesRepository } from '../db/repositories/candidates-repository';
import { createRuntimeStateRepository } from '../db/repositories/runtime-state-repository';
import { createCandidateControlMessagesRepository } from '../db/repositories/candidate-control-messages-repository';
import type { Queryable } from '../db/pool';
import type { XThreadLookupClient } from '../enrichment/x/client';
import type { HermesExecutor } from '../hermes/run-hermes';
import { publishCandidate } from '../publisher/publish-candidate';
import type { publishToXViaScript } from '../publisher/x-command';
import type { TelegramClient } from '../telegram/client';
import { formatSkipNotificationMessage } from '../telegram/command-parser';
import { buildRecentContextPacket } from './context-builder';
import { draftSelectedCandidate, type DrafterRunner } from './draft-candidate';
import {
  getCandidateTimerEffect,
  listCandidatesForAutomation,
  markDeliveryFailed,
  markReminderSent,
  requestCandidatePost,
} from './state-machine';
import { selectCandidate, type SelectorRunner } from './select-candidate';
import {
  findDueWindowSlots,
  parseWindowsJson,
  type RandomFractionForSlot,
} from './windows';

export type SyncSource = {
  name: string;
  sync(): Promise<unknown>;
};

type SharedDraftPipelineDependencies = {
  db: Queryable;
  telegramClient: TelegramClient;
  syncSources?: readonly SyncSource[] | undefined;
  now?: (() => Date) | undefined;
  runSelector?: SelectorRunner | undefined;
  runDrafter?: DrafterRunner | undefined;
  hermesBin?: string | undefined;
  hermesExecutor?: HermesExecutor | undefined;
  xLookupClient?: XThreadLookupClient | undefined;
  dryRun?: boolean | undefined;
};

export type SharedDraftPipelineInput = SharedDraftPipelineDependencies & {
  triggerType: 'scheduled' | 'on_demand';
  deadlineAt?: Date | null | undefined;
};

export type RunTickInput = SharedDraftPipelineDependencies & {
  controlChatId: string;
  windowsJson: unknown[];
  randomFractionForSlot?: RandomFractionForSlot | undefined;
  postProfile?: string | undefined;
  clawdTweetScript?: string | undefined;
  publishToX?: typeof publishToXViaScript | undefined;
};

export type RunTickResult = {
  dryRun: boolean;
  processedActionCount: number;
  dueWindowSlotIds: string[];
  reminderCandidateIds: string[];
  postRequestedCandidateIds: string[];
  createdCandidateIds: string[];
};

const SLOT_STATE_KEY_PREFIX = 'scheduled_window_slot:';
const DEADLINE_MINUTES = 15;
const MAX_DRAFTER_ATTEMPTS = 2;
type WindowSlotLifecycleStatus = 'in_progress' | 'retry_pending' | 'completed' | 'skipped';

type FinalizedWindowSlotOutcome =
  | 'draft_ready'
  | 'selector_skipped'
  | 'selector_failed'
  | 'drafter_skipped'
  | 'drafter_failed'
  | 'delivery_failed';

type SharedDraftPipelineResult =
  | {
    outcome: 'dry_run';
    candidateId: null;
    errorDetails: null;
  }
  | {
    outcome: 'draft_ready' | 'selector_skipped' | 'drafter_skipped' | 'delivery_failed';
    candidateId: string;
    errorDetails: string | null;
  }
  | {
    outcome: 'selector_failed';
    candidateId: null;
    errorDetails: string;
  }
  | {
    outcome: 'drafter_failed';
    candidateId: string;
    errorDetails: string;
  };

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60 * 1000);
}

function buildWindowSlotStateKey(slotId: string): string {
  return `${SLOT_STATE_KEY_PREFIX}${slotId}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return String(error);
}

async function sendSkipNotification(input: {
  telegramClient: TelegramClient;
  stage: 'selector' | 'drafter';
  triggerType: 'scheduled' | 'on_demand';
  candidateId: string;
  candidateType?: string | null | undefined;
  reason?: string | null | undefined;
}): Promise<void> {
  try {
    await input.telegramClient.sendMessage({
      text: formatSkipNotificationMessage({
        stage: input.stage,
        triggerType: input.triggerType,
        candidateId: input.candidateId,
        candidateType: input.candidateType,
        reason: input.reason,
      }),
      disableWebPagePreview: true,
    });
  } catch {
    // Skip notifications are informational only.
  }
}

function getWindowSlotStatus(stateJson: unknown): WindowSlotLifecycleStatus | null {
  if (
    typeof stateJson === 'object'
    && stateJson !== null
    && 'status' in stateJson
    && typeof stateJson.status === 'string'
    && (
      stateJson.status === 'in_progress'
      || stateJson.status === 'retry_pending'
      || stateJson.status === 'completed'
      || stateJson.status === 'skipped'
    )
  ) {
    return stateJson.status;
  }

  return null;
}

function isFinalizedWindowSlotState(stateJson: unknown): boolean {
  const status = getWindowSlotStatus(stateJson);

  return status === 'completed' || status === 'skipped';
}

async function listFinalizedSlotIds(
  runtimeStateRepository: ReturnType<typeof createRuntimeStateRepository>,
): Promise<Set<string>> {
  const slotStates = await runtimeStateRepository.listStatesByPrefix(SLOT_STATE_KEY_PREFIX);

  return new Set(
    slotStates
      .filter((state) => isFinalizedWindowSlotState(state.stateJson))
      .map((state) => state.stateKey.slice(SLOT_STATE_KEY_PREFIX.length)),
  );
}

function buildInProgressWindowSlotState(input: {
  slot: {
    slotId: string;
    windowName: string;
    scheduledFor: Date;
  };
  now: Date;
  attemptCount: number;
  ownerId: string;
}) {
  return {
    slotId: input.slot.slotId,
    windowName: input.slot.windowName,
    scheduledFor: input.slot.scheduledFor.toISOString(),
    status: 'in_progress' as const,
    attemptCount: input.attemptCount,
    ownerId: input.ownerId,
    claimedAt: input.now.toISOString(),
  };
}

async function claimWindowSlot(input: {
  runtimeStateRepository: ReturnType<typeof createRuntimeStateRepository>;
  slot: {
    slotId: string;
    windowName: string;
    scheduledFor: Date;
  };
  now: Date;
  ownerId: string;
}): Promise<{ attemptCount: number } | null> {
  const stateKey = buildWindowSlotStateKey(input.slot.slotId);
  const inserted = await input.runtimeStateRepository.insertStateIfAbsent(
    stateKey,
    buildInProgressWindowSlotState({
      slot: input.slot,
      now: input.now,
      attemptCount: 1,
      ownerId: input.ownerId,
    }),
  );

  if (inserted) {
    return { attemptCount: 1 };
  }

  const existingState = await input.runtimeStateRepository.getState(stateKey);

  if (getWindowSlotStatus(existingState?.stateJson) !== 'retry_pending') {
    return null;
  }

  const nextAttemptCount = getRetryAttemptCount(existingState?.stateJson) + 1;
  const claimedRetry = await input.runtimeStateRepository.setStateIfStatus(
    stateKey,
    'retry_pending',
    buildInProgressWindowSlotState({
      slot: input.slot,
      now: input.now,
      attemptCount: nextAttemptCount,
      ownerId: input.ownerId,
    }),
  );

  if (!claimedRetry) {
    return null;
  }

  return { attemptCount: nextAttemptCount };
}

async function runSyncSources(sources: readonly SyncSource[]): Promise<{ degraded: boolean }> {
  let degraded = false;

  for (const source of sources) {
    try {
      await source.sync();
    } catch {
      degraded = true;
    }
  }

  return { degraded };
}

async function markDrafterFailure(input: {
  db: Queryable;
  candidateId: string;
  errorDetails: string;
  degraded: boolean;
}): Promise<void> {
  await createCandidatesRepository(input.db).transitionStatus({
    id: input.candidateId,
    fromStatuses: ['drafting'],
    toStatus: 'drafter_skipped',
    degraded: input.degraded,
    errorDetails: input.errorDetails,
  });
}

function getRetryAttemptCount(stateJson: unknown): number {
  if (
    typeof stateJson === 'object'
    && stateJson !== null
    && 'attemptCount' in stateJson
    && typeof stateJson.attemptCount === 'number'
    && Number.isInteger(stateJson.attemptCount)
    && stateJson.attemptCount >= 0
  ) {
    return stateJson.attemptCount;
  }

  return 0;
}

async function finalizeWindowSlot(input: {
  runtimeStateRepository: ReturnType<typeof createRuntimeStateRepository>;
  slot: {
    slotId: string;
    windowName: string;
    scheduledFor: Date;
  };
  now: Date;
  outcome: FinalizedWindowSlotOutcome;
  attemptCount: number;
  ownerId: string;
  candidateId: string | null;
  errorDetails: string | null;
}): Promise<void> {
  await input.runtimeStateRepository.setState(buildWindowSlotStateKey(input.slot.slotId), {
    slotId: input.slot.slotId,
    windowName: input.slot.windowName,
    scheduledFor: input.slot.scheduledFor.toISOString(),
    status: input.outcome === 'draft_ready' ? 'completed' : 'skipped',
    outcome: input.outcome,
    attemptCount: input.attemptCount,
    ownerId: input.ownerId,
    candidateId: input.candidateId,
    errorDetails: input.errorDetails,
    resolvedAt: input.now.toISOString(),
  });
}

async function rememberRetryableWindowSlotFailure(input: {
  runtimeStateRepository: ReturnType<typeof createRuntimeStateRepository>;
  slot: {
    slotId: string;
    windowName: string;
    scheduledFor: Date;
  };
  now: Date;
  attemptCount: number;
  ownerId: string;
  candidateId: string;
  errorDetails: string;
}): Promise<void> {
  await input.runtimeStateRepository.setState(buildWindowSlotStateKey(input.slot.slotId), {
    slotId: input.slot.slotId,
    windowName: input.slot.windowName,
    scheduledFor: input.slot.scheduledFor.toISOString(),
    status: 'retry_pending',
    attemptCount: input.attemptCount,
    ownerId: input.ownerId,
    candidateId: input.candidateId,
    errorDetails: input.errorDetails,
    lastFailedAt: input.now.toISOString(),
  });
}

async function runSharedDraftPipeline(input: SharedDraftPipelineInput): Promise<SharedDraftPipelineResult> {
  if (input.dryRun) {
    return {
      outcome: 'dry_run',
      candidateId: null,
      errorDetails: null,
    };
  }

  const now = input.now ?? (() => new Date());
  const syncSources = input.syncSources ?? [];
  const candidatesRepository = createCandidatesRepository(input.db);
  const syncResult = await runSyncSources(syncSources);
  const controlMessagesRepository = createCandidateControlMessagesRepository(input.db);
  let selected: Awaited<ReturnType<typeof selectCandidate>>;

  try {
    const context = await buildRecentContextPacket({
      db: input.db,
      now,
    });
    selected = await selectCandidate({
      db: input.db,
      context,
      triggerType: input.triggerType,
      fallbackOnSkip: input.triggerType === 'scheduled',
      runSelector: input.runSelector,
      hermesBin: input.hermesBin,
      hermesExecutor: input.hermesExecutor,
      xLookupClient: input.xLookupClient,
    });
  } catch (error) {
    return {
      outcome: 'selector_failed',
      candidateId: null,
      errorDetails: formatError(error),
    };
  }

  if (selected.outcome === 'skip') {
    if (syncResult.degraded) {
      await candidatesRepository.updateCandidate(selected.candidate.id, { degraded: true });
    }

    await sendSkipNotification({
      telegramClient: input.telegramClient,
      stage: 'selector',
      triggerType: input.triggerType,
      candidateId: selected.candidate.id,
      candidateType: selected.candidate.candidateType,
      reason: selected.candidate.errorDetails,
    });

    return {
      outcome: 'selector_skipped',
      candidateId: selected.candidate.id,
      errorDetails: selected.candidate.errorDetails,
    };
  }

  let drafted: Awaited<ReturnType<typeof draftSelectedCandidate>>;

  try {
    await candidatesRepository.updateCandidate(selected.candidate.id, {
      deadlineAt: input.deadlineAt ?? null,
      degraded: syncResult.degraded,
    });

    drafted = await draftSelectedCandidate({
      db: input.db,
      selected,
      runDrafter: input.runDrafter,
      hermesBin: input.hermesBin,
      hermesExecutor: input.hermesExecutor,
    });
  } catch (error) {
    const errorDetails = formatError(error);
    await markDrafterFailure({
      db: input.db,
      candidateId: selected.candidate.id,
      errorDetails,
      degraded: syncResult.degraded,
    });

    return {
      outcome: 'drafter_failed',
      candidateId: selected.candidate.id,
      errorDetails,
    };
  }

  if (drafted.outcome !== 'ready') {
    if (syncResult.degraded) {
      await candidatesRepository.updateCandidate(drafted.candidate.id, { degraded: true });
    }

    await sendSkipNotification({
      telegramClient: input.telegramClient,
      stage: 'drafter',
      triggerType: input.triggerType,
      candidateId: drafted.candidate.id,
      candidateType: drafted.candidate.candidateType,
      reason: drafted.candidate.errorDetails,
    });

    return {
      outcome: 'drafter_skipped',
      candidateId: drafted.candidate.id,
      errorDetails: drafted.candidate.errorDetails,
    };
  }

  try {
    const sentMessage = await input.telegramClient.sendCandidatePackage({
      candidateId: drafted.package.candidateId,
      candidateType: drafted.package.candidateType,
      deliveryKind: drafted.package.deliveryKind,
      deadlineAt: drafted.package.deadlineAt,
      draftText: drafted.package.draftText,
      threadReplyText: drafted.package.threadReplyText,
      mediaRequest: drafted.package.mediaRequest,
      quoteTargetUrl: drafted.package.quoteTargetUrl,
    });
    await candidatesRepository.updateCandidate(drafted.candidate.id, {
      telegramMessageId: String(sentMessage.message_id),
    });
    await controlMessagesRepository.recordControlMessage({
      candidateId: drafted.candidate.id,
      telegramMessageId: String(sentMessage.message_id),
      messageKind: 'draft',
    });
  } catch (error) {
    await markDeliveryFailed({
      db: input.db,
      candidateId: drafted.candidate.id,
      errorDetails: formatError(error),
    });

    return {
      outcome: 'delivery_failed',
      candidateId: drafted.candidate.id,
      errorDetails: formatError(error),
    };
  }

  return {
    outcome: 'draft_ready',
    candidateId: drafted.candidate.id,
    errorDetails: null,
  };
}

async function sendReminder(input: {
  db: Queryable;
  telegramClient: TelegramClient;
  candidateId: string;
  candidateType: string;
  deadlineAt: Date;
  draftText: string | null;
  mediaRequest: string | null;
  quoteTargetUrl: string | null;
  now: () => Date;
}): Promise<boolean> {
  const candidatesRepository = createCandidatesRepository(input.db);
  const controlMessagesRepository = createCandidateControlMessagesRepository(input.db);

  try {
    const sentMessage = await input.telegramClient.sendCandidatePackage({
      candidateId: input.candidateId,
      candidateType: input.candidateType,
      deadlineAt: input.deadlineAt,
      draftText: input.draftText ?? '',
      mediaRequest: input.mediaRequest,
      quoteTargetUrl: input.quoteTargetUrl,
    });
    await candidatesRepository.updateCandidate(input.candidateId, {
      telegramMessageId: String(sentMessage.message_id),
    });
    await controlMessagesRepository.recordControlMessage({
      candidateId: input.candidateId,
      telegramMessageId: String(sentMessage.message_id),
      messageKind: 'reminder',
    });
  } catch {
    return false;
  }

  await markReminderSent({
    db: input.db,
    candidateId: input.candidateId,
    now: input.now,
  });
  return true;
}

async function publishRequestedCandidate(input: {
  db: Queryable;
  telegramClient: TelegramClient;
  candidateId: string;
  postProfile?: string | undefined;
  clawdTweetScript?: string | undefined;
  now: () => Date;
  publishToX?: typeof publishToXViaScript | undefined;
}): Promise<void> {
  if (!input.postProfile || !input.clawdTweetScript) {
    throw new Error('postProfile and clawdTweetScript are required when publishing');
  }

  await publishCandidate({
    db: input.db,
    telegramClient: input.telegramClient,
    candidateId: input.candidateId,
    postProfile: input.postProfile,
    clawdTweetScript: input.clawdTweetScript,
    now: input.now,
    publishToX: input.publishToX,
  });
}

export async function runTick(input: RunTickInput): Promise<RunTickResult> {
  const now = input.now ?? (() => new Date());
  const dryRun = input.dryRun ?? false;
  const runtimeStateRepository = createRuntimeStateRepository(input.db);
  const windows = parseWindowsJson(input.windowsJson);
  const finalizedSlotIds = await listFinalizedSlotIds(runtimeStateRepository);
  const dueSlots = findDueWindowSlots({
    windows,
    now: now(),
    claimedSlotIds: finalizedSlotIds,
    randomFractionForSlot: input.randomFractionForSlot,
  });
  const reminderCandidateIds: string[] = [];
  const postRequestedCandidateIds: string[] = [];
  const createdCandidateIds: string[] = [];
  const tickRunId = randomUUID();

  if (dryRun) {
    const candidates = await listCandidatesForAutomation(input.db);

    for (const candidate of candidates) {
      const effect = getCandidateTimerEffect({
        candidate,
        now: now(),
      });

      if (effect === 'send_reminder') {
        reminderCandidateIds.push(candidate.id);
      }

      if (effect === 'request_post') {
        postRequestedCandidateIds.push(candidate.id);
      }
    }

    return {
      dryRun,
      processedActionCount: 0,
      dueWindowSlotIds: dueSlots.map((slot) => slot.slotId),
      reminderCandidateIds,
      postRequestedCandidateIds,
      createdCandidateIds,
    };
  }

  for (const slot of dueSlots) {
    const claimedSlot = await claimWindowSlot({
      runtimeStateRepository,
      slot,
      now: now(),
      ownerId: tickRunId,
    });

    if (!claimedSlot) {
      continue;
    }

    const nextAttemptCount = claimedSlot.attemptCount;

    const result = await runSharedDraftPipeline({
      db: input.db,
      telegramClient: input.telegramClient,
      syncSources: input.syncSources,
      triggerType: 'scheduled',
      deadlineAt: addMinutes(now(), DEADLINE_MINUTES),
      now,
      runSelector: input.runSelector,
      runDrafter: input.runDrafter,
      hermesBin: input.hermesBin,
      hermesExecutor: input.hermesExecutor,
      xLookupClient: input.xLookupClient,
    });

    if (result.candidateId !== null) {
      createdCandidateIds.push(result.candidateId);
    }

    const processedAt = now();

    if (result.outcome === 'dry_run') {
      continue;
    }

    if (result.outcome === 'drafter_failed' && nextAttemptCount < MAX_DRAFTER_ATTEMPTS) {
      await rememberRetryableWindowSlotFailure({
        runtimeStateRepository,
        slot,
        now: processedAt,
        attemptCount: nextAttemptCount,
        ownerId: tickRunId,
        candidateId: result.candidateId,
        errorDetails: result.errorDetails,
      });
      continue;
    }

    const finalizedOutcome: FinalizedWindowSlotOutcome =
      result.outcome === 'drafter_failed' ? 'drafter_failed' : result.outcome;

    await finalizeWindowSlot({
      runtimeStateRepository,
      slot,
      now: processedAt,
      outcome: finalizedOutcome,
      attemptCount: nextAttemptCount,
      ownerId: tickRunId,
      candidateId: result.candidateId,
      errorDetails: result.errorDetails,
    });
  }

  const candidates = await listCandidatesForAutomation(input.db);

  for (const candidate of candidates) {
    if (candidate.status === 'post_requested') {
      if (input.postProfile && input.clawdTweetScript) {
        await publishRequestedCandidate({
          db: input.db,
          telegramClient: input.telegramClient,
          candidateId: candidate.id,
          postProfile: input.postProfile,
          clawdTweetScript: input.clawdTweetScript,
          now,
          publishToX: input.publishToX,
        });
        postRequestedCandidateIds.push(candidate.id);
      }
      continue;
    }

    const effect = getCandidateTimerEffect({
      candidate,
      now: now(),
    });

    if (effect === 'send_reminder' && candidate.deadlineAt) {
      const sent = await sendReminder({
        db: input.db,
        telegramClient: input.telegramClient,
        candidateId: candidate.id,
        candidateType: candidate.candidateType,
        deadlineAt: candidate.deadlineAt,
        draftText: candidate.finalPostText,
        mediaRequest: candidate.mediaRequest,
        quoteTargetUrl: candidate.quoteTargetUrl,
        now,
      });

      if (sent) {
        reminderCandidateIds.push(candidate.id);
      }
    }

    if (effect === 'request_post') {
      const transitioned = await requestCandidatePost({
        db: input.db,
        candidateId: candidate.id,
        fromStatuses: ['pending_approval', 'reminded'],
      });

      if (transitioned) {
        await publishRequestedCandidate({
          db: input.db,
          telegramClient: input.telegramClient,
          candidateId: transitioned.id,
          postProfile: input.postProfile,
          clawdTweetScript: input.clawdTweetScript,
          now,
          publishToX: input.publishToX,
        });
        postRequestedCandidateIds.push(candidate.id);
      }
    }
  }

  return {
    dryRun,
    processedActionCount: 0,
    dueWindowSlotIds: dueSlots.map((slot) => slot.slotId),
    reminderCandidateIds,
    postRequestedCandidateIds,
    createdCandidateIds,
  };
}

export async function runOnDemandDraft(input: SharedDraftPipelineDependencies): Promise<{ candidateId: string | null }> {
  const result = await runSharedDraftPipeline({
    ...input,
    triggerType: 'on_demand',
    deadlineAt: null,
  });

  if (result.outcome === 'selector_failed' || result.outcome === 'drafter_failed') {
    throw new Error(result.errorDetails);
  }

  return {
    candidateId: result.candidateId,
  };
}
