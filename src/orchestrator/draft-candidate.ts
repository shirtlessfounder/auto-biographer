import { createCandidatesRepository, type CandidateRecord } from '../db/repositories/candidates-repository';
import type { Queryable } from '../db/pool';
import { resolvePublicGitHubRepoUrl } from '../github/repo-link';
import {
  runHermesDrafter,
  type HermesExecutor,
} from '../hermes/run-hermes';
import type {
  HermesDrafterPayload,
  HermesDrafterResult,
  HermesSkipPayload,
} from '../hermes/schemas';
import type { SelectedCandidatePacket, SelectorSelectOutcome } from './select-candidate';

const QUOTE_TWEETS_ENABLED = false;

export type DrafterRunner = (input: SelectedCandidatePacket) => Promise<HermesDrafterResult>;

export type TelegramReadyCandidatePackage = {
  kind: 'candidate_package';
  candidateId: string;
  candidateType: string;
  deliveryKind: 'single_post' | 'thread';
  draftText: string;
  threadReplyText: string | null;
  deadlineAt: Date | null;
  quoteTargetUrl: string | null;
  mediaRequest: string | null;
  whyChosen: string;
  receipts: string[];
  allowedCommands: string[];
};

export type DraftSkipOutcome = {
  outcome: 'skip';
  candidate: CandidateRecord;
  drafterResult: HermesSkipPayload;
  package: null;
};

export type DraftReadyOutcome = {
  outcome: 'ready';
  candidate: CandidateRecord;
  drafterResult: HermesDrafterPayload;
  package: TelegramReadyCandidatePackage;
};

export type DraftSelectedCandidateOutcome = DraftSkipOutcome | DraftReadyOutcome;

export type DraftSelectedCandidateInput = {
  db: Queryable;
  selected: SelectorSelectOutcome;
  runDrafter?: DrafterRunner | undefined;
  hermesBin?: string | undefined;
  hermesExecutor?: HermesExecutor | undefined;
  resolvePublicRepoLinkUrl?: typeof resolvePublicGitHubRepoUrl | undefined;
};

function buildDrafterRunner(input: Pick<DraftSelectedCandidateInput, 'runDrafter' | 'hermesBin' | 'hermesExecutor'>): DrafterRunner {
  if (input.runDrafter) {
    return input.runDrafter;
  }

  return (selectedPacket) =>
    runHermesDrafter({
      input: selectedPacket,
      hermesBin: input.hermesBin,
      executor: input.hermesExecutor,
    });
}

function truncateTweetText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildDefaultOriginalPostMediaRequest(selectedPacket: SelectedCandidatePacket): string | null {
  if (selectedPacket.selection.quoteTargetUrl !== null) {
    return null;
  }

  if (selectedPacket.selection.suggestedMediaRequest) {
    return selectedPacket.selection.suggestedMediaRequest;
  }

  if (selectedPacket.repoLinkUrl) {
    return 'screenshot of the repo, README, terminal output, or shipped artifact that best supports the update';
  }

  return `image or screenshot that best supports: ${truncateTweetText(selectedPacket.selection.primaryAnchor, 120)}`;
}

function buildForcedDraftFromSelection(input: {
  selectedPacket: SelectedCandidatePacket;
  drafterSkipReason: string;
}): HermesDrafterPayload {
  const selection = input.selectedPacket.selection;
  const primary = truncateTweetText(selection.primaryAnchor, 220);
  const support = selection.supportingPoints[0] ? truncateTweetText(selection.supportingPoints[0], 120) : null;
  const angle = truncateTweetText(selection.angle, 140);

  const draftText = truncateTweetText(
    support && !primary.toLowerCase().includes(support.toLowerCase())
      ? `${primary} — ${support}`
      : primary,
    280,
  );

  return {
    decision: 'success',
    delivery_kind: 'single_post',
    draft_text: draftText,
    candidate_type: selection.candidateType,
    quote_target_url: selection.quoteTargetUrl,
    why_chosen: `forced tweet after drafter skip: ${input.drafterSkipReason}`,
    receipts: [angle, ...selection.supportingPoints].slice(0, 3).map((value) => truncateTweetText(value, 160)),
    media_request: buildDefaultOriginalPostMediaRequest(input.selectedPacket),
    allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
  };
}

function assertTweetLength(text: string, label: string): void {
  if (text.length > 280) {
    throw new Error(`${label} exceeds the 280 character X limit (${String(text.length)})`);
  }
}

async function transitionCandidate(
  db: Queryable,
  input: {
    candidateId: string;
    toStatus: string;
    drafterOutputJson: unknown;
    finalPostText?: string | null | undefined;
    quoteTargetUrl?: string | null | undefined;
    mediaRequest?: string | null | undefined;
    errorDetails?: string | null | undefined;
  },
): Promise<CandidateRecord> {
  const candidatesRepository = createCandidatesRepository(db);
  const candidate = await candidatesRepository.transitionStatus({
    id: input.candidateId,
    fromStatuses: ['drafting'],
    toStatus: input.toStatus,
    drafterOutputJson: input.drafterOutputJson,
    finalPostText: input.finalPostText,
    quoteTargetUrl: input.quoteTargetUrl,
    mediaRequest: input.mediaRequest,
    errorDetails: input.errorDetails,
  });

  if (!candidate) {
    throw new Error(`Candidate ${input.candidateId} is not in drafting state`);
  }

  return candidate;
}

export async function draftSelectedCandidate({
  db,
  selected,
  runDrafter,
  hermesBin,
  hermesExecutor,
  resolvePublicRepoLinkUrl,
}: DraftSelectedCandidateInput): Promise<DraftSelectedCandidateOutcome> {
  const drafter = buildDrafterRunner({ runDrafter, hermesBin, hermesExecutor });
  const rawDrafterResult = await drafter(selected.selectedPacket);
  const drafterResult = rawDrafterResult.decision === 'skip'
    ? buildForcedDraftFromSelection({
        selectedPacket: selected.selectedPacket,
        drafterSkipReason: rawDrafterResult.reason,
      })
    : rawDrafterResult;

  const quoteTargetUrl = QUOTE_TWEETS_ENABLED
    ? drafterResult.quote_target_url ?? selected.selectedPacket.selection.quoteTargetUrl
    : null;
  assertTweetLength(drafterResult.draft_text, 'draft_text');
  const repoLinkResolver = resolvePublicRepoLinkUrl ?? resolvePublicGitHubRepoUrl;
  const threadReplyText =
    quoteTargetUrl === null
      ? await repoLinkResolver({ repoUrl: selected.selectedPacket.repoLinkUrl })
      : null;

  if (threadReplyText !== null) {
    assertTweetLength(threadReplyText, 'thread_reply_text');
  }

  const mediaRequest = drafterResult.media_request
    ?? selected.selectedPacket.selection.suggestedMediaRequest
    ?? buildDefaultOriginalPostMediaRequest(selected.selectedPacket);
  const candidate = await transitionCandidate(db, {
    candidateId: selected.candidate.id,
    toStatus: 'pending_approval',
    drafterOutputJson: drafterResult,
    finalPostText: drafterResult.draft_text,
    quoteTargetUrl,
    mediaRequest,
    errorDetails: null,
  });

  return {
    outcome: 'ready',
    drafterResult,
    candidate,
    package: {
      kind: 'candidate_package',
      candidateId: candidate.id,
      candidateType: drafterResult.candidate_type,
      deliveryKind: threadReplyText === null ? 'single_post' : 'thread',
      draftText: drafterResult.draft_text,
      threadReplyText,
      deadlineAt: candidate.deadlineAt,
      quoteTargetUrl,
      mediaRequest,
      whyChosen: drafterResult.why_chosen,
      receipts: drafterResult.receipts,
      allowedCommands: drafterResult.allowed_commands,
    },
  };
}
