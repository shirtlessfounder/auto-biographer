import { randomUUID } from 'node:crypto';

import { createCandidatesRepository } from '../db/repositories/candidates-repository';
import { createRuntimeStateRepository } from '../db/repositories/runtime-state-repository';
import { createTelegramActionsRepository } from '../db/repositories/telegram-actions-repository';
import type { Queryable } from '../db/pool';
import type { XThreadLookupClient } from '../enrichment/x/client';
import type { HermesExecutor } from '../hermes/run-hermes';
import { publishCandidate } from '../publisher/publish-candidate';
import type { publishToXViaOAuth } from '../publisher/x-poster';
import { createTelegramUpdatePoller } from '../telegram/poll-updates';
import type { TelegramClient } from '../telegram/client';
import { formatSkipNotificationMessage } from '../telegram/command-parser';
import { buildRecentContextPacket } from './context-builder';
import { draftSelectedCandidate, type DrafterRunner } from './draft-candidate';
import {
  applyCandidateAction,
  getCandidateTimerEffect,
  listCandidatesForAutomation,
  markDeliveryFailed,
  markReminderSent,
  requestCandidatePost,
} from './state-machine';
import { selectCandidate, type SelectorRunner } from './select-candidate';
import {
  buildWindowSlotId,
  findDueWindowSlots,
  getOrCreateWindowTargetFraction,
  parseWindowsJson,
  type RandomFractionForSlot,
  type WindowDefinition,
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
  publishGraceMinutes?: number | undefined;
};

export type SharedDraftPipelineInput = SharedDraftPipelineDependencies & {
  triggerType: 'scheduled' | 'on_demand';
  deadlineAt?: Date | null | undefined;
  slot?: {
    slotId: string;
    windowName: string;
    scheduledFor: Date;
    ownerId: string;
    attemptCount: number;
  };
};

export type RunTickInput = SharedDraftPipelineDependencies & {
  controlChatId: string;
  windowsJson: unknown[];
  randomFractionForSlot?: RandomFractionForSlot | undefined;
  postProfile?: string | undefined;
  oauthCredentials?: {
    consumerKey: string;
    consumerSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  } | undefined;
  xApiBaseUrl?: string | undefined;
  publishToX?: typeof publishToXViaOAuth | undefined;
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
    outcome: 'draft_ready';
    candidateId: string;
    errorDetails: string | null;
  }
  | {
    outcome: 'selector_skipped';
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
  }
  | {
    outcome: 'delivery_failed';
    candidateId: string;
    errorDetails: string | null;
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

// Slots stuck in `in_progress` beyond this threshold are assumed to be orphans
// from a crashed/killed tick. Legitimate ticks never exceed a few minutes.
const STUCK_SLOT_THRESHOLD_MS = 15 * 60 * 1000;

async function reapStuckWindowSlots(input: {
  runtimeStateRepository: ReturnType<typeof createRuntimeStateRepository>;
  telegramClient: TelegramClient;
}): Promise<string[]> {
  const reaped = await input.runtimeStateRepository.reapStuckSlots(
    SLOT_STATE_KEY_PREFIX,
    STUCK_SLOT_THRESHOLD_MS,
  );

  if (reaped.length === 0) {
    return [];
  }

  const reapedSlotIds = reaped.map((state) =>
    state.stateKey.slice(SLOT_STATE_KEY_PREFIX.length),
  );

  console.error(`[tick] reaper: reclaimed ${String(reapedSlotIds.length)} stuck slot(s): ${reapedSlotIds.join(', ')}`);

  try {
    await input.telegramClient.sendMessage({
      text: `reaper: reclaimed stuck slot(s): ${reapedSlotIds.join(', ')}`,
      disableWebPagePreview: true,
    });
  } catch {
    // Alert is best-effort.
  }

  return reapedSlotIds;
}

async function buildWindowFractionMap(input: {
  runtimeStateRepository: ReturnType<typeof createRuntimeStateRepository>;
  windows: readonly WindowDefinition[];
  now: Date;
}): Promise<Map<string, number>> {
  const fractions = new Map<string, number>();

  for (const window of input.windows) {
    const slotId = buildWindowSlotId(window, input.now);
    const fraction = await getOrCreateWindowTargetFraction(input.runtimeStateRepository, {
      slotId,
      window,
    });
    fractions.set(slotId, fraction);
  }

  return fractions;
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
  const runtimeStateRepository = createRuntimeStateRepository(input.db);

  const HEARTBEAT_INTERVAL_MS = 60 * 1000;
  const stopRef = { stopped: false };
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  if (input.slot) {
    heartbeatTimer = setInterval(async () => {
      if (stopRef.stopped) return;
      try {
        const stateKey = buildWindowSlotStateKey(input.slot.slotId);
        await runtimeStateRepository.setState(stateKey, {
          slotId: input.slot.slotId,
          windowName: input.slot.windowName,
          scheduledFor: input.slot.scheduledFor.toISOString(),
          status: 'in_progress',
          ownerId: input.slot.ownerId,
          claimedAt: new Date().toISOString(),
          attemptCount: input.slot.attemptCount,
        });
      } catch { /* best-effort */ }
    }, HEARTBEAT_INTERVAL_MS);
  }

  try {
  const syncResult = await runSyncSources(syncSources);
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
    console.error(`[tick] selector error: ${formatError(error)}`);
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
      publishGraceMinutes: input.publishGraceMinutes,
      now: input.now,
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
    throw new Error(`Unexpected draft outcome: ${(drafted as { outcome: string }).outcome}`);
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
  } finally {
    stopRef.stopped = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
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
  oauthCredentials?: {
    consumerKey: string;
    consumerSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  } | undefined;
  xApiBaseUrl?: string | undefined;
  now: () => Date;
  publishToX?: typeof publishToXViaOAuth | undefined;
}): Promise<void> {
  if (!input.postProfile || !input.oauthCredentials) {
    throw new Error('postProfile and oauthCredentials are required when publishing');
  }

  await publishCandidate({
    db: input.db,
    telegramClient: input.telegramClient,
    candidateId: input.candidateId,
    postProfile: input.postProfile,
    oauthCredentials: input.oauthCredentials,
    xApiBaseUrl: input.xApiBaseUrl,
    now: input.now,
    publishToX: input.publishToX,
  });
}

export async function runTick(input: RunTickInput): Promise<RunTickResult> {
  const now = input.now ?? (() => new Date());
  const dryRun = input.dryRun ?? false;
  const runtimeStateRepository = createRuntimeStateRepository(input.db);
  const telegramActionsRepository = createTelegramActionsRepository(input.db);
  const windows = parseWindowsJson(input.windowsJson);
  if (!dryRun) {
    await reapStuckWindowSlots({
      runtimeStateRepository,
      telegramClient: input.telegramClient,
    });
  }
  const finalizedSlotIds = await listFinalizedSlotIds(runtimeStateRepository);
  const fractionsByslotId = await buildWindowFractionMap({
    runtimeStateRepository,
    windows,
    now: now(),
  });
  const randomFractionForSlot: RandomFractionForSlot =
    input.randomFractionForSlot ?? ((slotId) => fractionsByslotId.get(slotId) ?? 0);
  const dueSlots = findDueWindowSlots({
    windows,
    now: now(),
    claimedSlotIds: finalizedSlotIds,
    randomFractionForSlot,
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

  const poller = createTelegramUpdatePoller({
    client: input.telegramClient,
    runtimeStateRepository,
    telegramActionsRepository,
    candidateMediaRepository: createCandidatesRepository(input.db),
    controlChatId: input.controlChatId,
    now,
  });
  const polled = await poller.pollUpdates();

  for (const action of polled.actions) {
    const actionResult = await applyCandidateAction({
      db: input.db,
      candidateId: action.candidateId,
      action: action.action,
      payload: action.payload,
      now,
    });

    if (actionResult.candidate?.status === 'post_requested') {
      await publishRequestedCandidate({
        db: input.db,
        telegramClient: input.telegramClient,
        candidateId: actionResult.candidate.id,
        postProfile: input.postProfile,
        oauthCredentials: input.oauthCredentials,
        xApiBaseUrl: input.xApiBaseUrl,
        now,
        publishToX: input.publishToX,
      });
      postRequestedCandidateIds.push(actionResult.candidate.id);
    }
  }

  for (const slot of dueSlots) {
    console.error(`[tick] processing slot: ${slot.slotId}`);
    const claim = await claimWindowSlot({
      runtimeStateRepository,
      slot,
      now: now(),
      ownerId: tickRunId,
    });

    if (!claim) {
      console.error(`[tick] slot=${slot.slotId} could not be claimed — skipping`);
      continue;
    }

    const { attemptCount } = claim;
    console.error(`[tick] slot=${slot.slotId} claimed (attempt ${attemptCount}) — running pipeline`);
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
      slot: {
        slotId: slot.slotId,
        windowName: slot.windowName,
        scheduledFor: slot.scheduledFor,
        ownerId: tickRunId,
        attemptCount,
      },
    });

    console.error(`[tick] slot=${slot.slotId} result.outcome=${result.outcome} candidateId=${result.candidateId}`);

    if (result.candidateId !== null) {
      createdCandidateIds.push(result.candidateId);
    }

    const processedAt = now();

    if (result.outcome === 'dry_run') {
      continue;
    }

    if (result.outcome === 'drafter_failed' && attemptCount < MAX_DRAFTER_ATTEMPTS) {
      await rememberRetryableWindowSlotFailure({
        runtimeStateRepository,
        slot,
        now: processedAt,
        attemptCount,
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
      attemptCount,
      ownerId: tickRunId,
      candidateId: result.candidateId,
      errorDetails: result.errorDetails,
    });
  }

  const candidates = await listCandidatesForAutomation(input.db);

  for (const candidate of candidates) {
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
          oauthCredentials: input.oauthCredentials,
          xApiBaseUrl: input.xApiBaseUrl,
          now,
          publishToX: input.publishToX,
        });
        postRequestedCandidateIds.push(candidate.id);
      }
    }

    // Drain orphans: a candidate already in post_requested needs publishing,
    // e.g. from a CLI apply-command post_now call outside a tick, or from a
    // previous tick that crashed between transition and publish.
    if (candidate.status === 'post_requested') {
      await publishRequestedCandidate({
        db: input.db,
        telegramClient: input.telegramClient,
        candidateId: candidate.id,
        postProfile: input.postProfile,
        oauthCredentials: input.oauthCredentials,
        xApiBaseUrl: input.xApiBaseUrl,
        now,
        publishToX: input.publishToX,
      });
      postRequestedCandidateIds.push(candidate.id);
    }
  }

  return {
    dryRun,
    processedActionCount: polled.actions.length,
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
