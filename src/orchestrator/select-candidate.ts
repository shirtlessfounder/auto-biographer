import { createCandidatesRepository, type CandidateRecord } from '../db/repositories/candidates-repository';
import type { Queryable } from '../db/pool';
import type { EnrichedQuoteTarget } from '../enrichment/x/enrich-quote-target';
import type { XThreadLookupClient } from '../enrichment/x/client';
import { findRelevantGitHubRepoUrl } from '../github/repo-link';
import {
  runHermesSelector,
  type HermesExecutor,
} from '../hermes/run-hermes';
import type {
  HermesSelectorPayload,
  HermesSelectorResult,
  HermesSkipPayload,
} from '../hermes/schemas';
import type {
  ContextArtifact,
  ContextEvent,
  RecentContextPacket,
  RecentPublishedPostSummary,
} from './context-builder';

type CandidateSourceLinkRow = {
  candidate_id: string;
  event_id: string;
  artifact_id: string | null;
};

export type SelectorRunner = (input: RecentContextPacket) => Promise<HermesSelectorResult>;

export type SelectedCandidatePacket = {
  kind: 'selected_candidate';
  candidateId: string;
  triggerType: string;
  contextWindow: {
    generatedAt: string;
    windowStart: string;
    windowEnd: string;
  };
  recentPublishedPosts: RecentPublishedPostSummary[];
  selection: {
    candidateType: string;
    angle: string;
    whyInteresting: string;
    sourceEventIds: number[];
    artifactIds: number[];
    primaryAnchor: string;
    supportingPoints: string[];
    quoteTargetUrl: string | null;
    suggestedMediaKind: string | null;
    suggestedMediaRequest: string | null;
  };
  events: ContextEvent[];
  artifacts: ContextArtifact[];
  quoteTargetEnrichment: EnrichedQuoteTarget | null;
  repoLinkUrl: string | null;
};

export type SelectorSkipOutcome = {
  outcome: 'skip';
  candidate: CandidateRecord;
  selectorResult: HermesSkipPayload;
};

export type SelectorSelectOutcome = {
  outcome: 'select';
  candidate: CandidateRecord;
  selectorResult: HermesSelectorPayload;
  selectedPacket: SelectedCandidatePacket;
};

export type SelectCandidateOutcome = SelectorSkipOutcome | SelectorSelectOutcome;

export type SelectCandidateInput = {
  db: Queryable;
  context: RecentContextPacket;
  triggerType: string;
  fallbackOnSkip?: boolean | undefined;
  runSelector?: SelectorRunner | undefined;
  hermesBin?: string | undefined;
  hermesExecutor?: HermesExecutor | undefined;
  xLookupClient?: XThreadLookupClient | undefined;
};

type RawSlackLinkPayload = Record<string, unknown> & {
  canonicalUrl?: unknown;
  domain?: unknown;
  finalUrl?: unknown;
  sourceUrl?: unknown;
};

const QUOTE_TWEETS_ENABLED = false;

function getString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return String(error);
}

function buildSelectorRunner(input: Pick<SelectCandidateInput, 'runSelector' | 'hermesBin' | 'hermesExecutor'>): SelectorRunner {
  if (input.runSelector) {
    return input.runSelector;
  }

  return (context) =>
    runHermesSelector({
      input: context,
      hermesBin: input.hermesBin,
      executor: input.hermesExecutor,
    });
}

function findSelectedEvents(context: RecentContextPacket, sourceEventIds: readonly number[]): ContextEvent[] {
  const eventsById = new Map(context.events.map((event) => [event.id, event] as const));

  return sourceEventIds.map((eventId) => {
    const event = eventsById.get(eventId);

    if (!event) {
      throw new Error(`Selector referenced missing event id ${String(eventId)}`);
    }

    return event;
  });
}

function findSelectedArtifacts(events: readonly ContextEvent[], artifactIds: readonly number[]): ContextArtifact[] {
  const artifactsById = new Map(
    events.flatMap((event) => event.artifacts.map((artifact) => [artifact.id, artifact] as const)),
  );

  return artifactIds.map((artifactId) => {
    const artifact = artifactsById.get(artifactId);

    if (!artifact) {
      throw new Error(`Selector referenced missing artifact id ${String(artifactId)}`);
    }

    return artifact;
  });
}

function dedupeArtifacts(artifacts: readonly ContextArtifact[]): ContextArtifact[] {
  const deduped = new Map<number, ContextArtifact>();

  for (const artifact of artifacts) {
    deduped.set(artifact.id, artifact);
  }

  return Array.from(deduped.values());
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function getEventSourcePriority(event: ContextEvent): number {
  switch (event.source) {
    case 'github':
      return 400;
    case 'agent_conversation':
      return 300;
    case 'slack_message':
      return 200;
    case 'slack_link':
      return 100;
    default:
      return 0;
  }
}

function scoreFallbackEvent(event: ContextEvent): number {
  let score = getEventSourcePriority(event);

  if (event.artifacts.length > 0) {
    score += 25;
  }

  if (getString(event.title) !== null) {
    score += 10;
  }

  if (getString(event.summary) !== null) {
    score += 10;
  }

  if (getString(event.rawText) !== null) {
    score += 5;
  }

  return score;
}

function compareFallbackEvents(left: ContextEvent, right: ContextEvent): number {
  const scoreDelta = scoreFallbackEvent(right) - scoreFallbackEvent(left);

  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const occurredAtDelta = new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();

  if (occurredAtDelta !== 0) {
    return occurredAtDelta;
  }

  return right.id - left.id;
}

function buildFallbackPrimaryAnchor(event: ContextEvent): string {
  const candidates = [
    getString(event.title),
    getString(event.summary),
    getString(event.rawText),
    ...event.artifacts.map((artifact) => getString(artifact.contentText)),
  ];

  for (const candidate of candidates) {
    if (candidate !== null) {
      return truncateText(normalizeWhitespace(candidate), 160);
    }
  }

  return `${event.source} activity from ${event.occurredAt}`;
}

function buildFallbackSupportingPoints(event: ContextEvent, primaryAnchor: string, skipReason: string): string[] {
  const supportingPoints: string[] = [];
  const seen = new Set<string>([primaryAnchor]);

  const maybeAdd = (value: string | null) => {
    if (value === null) {
      return;
    }

    const normalized = truncateText(normalizeWhitespace(value), 160);

    if (seen.has(normalized)) {
      return;
    }

    supportingPoints.push(normalized);
    seen.add(normalized);
  };

  maybeAdd(event.summary);
  maybeAdd(event.rawText);
  maybeAdd(event.artifacts[0]?.contentText ?? null);
  maybeAdd(`Source: ${event.source}`);
  maybeAdd(`Selector skipped this slot: ${skipReason}`);

  if (supportingPoints.length === 0) {
    supportingPoints.push('Scheduled fallback picked the strongest recent context still available.');
  }

  return supportingPoints;
}

function buildFallbackSelectorPayload(
  context: RecentContextPacket,
  skipReason: string,
): HermesSelectorPayload | null {
  const selectedEvent = [...context.events].sort(compareFallbackEvents)[0];

  if (!selectedEvent) {
    return null;
  }

  const primaryAnchor = buildFallbackPrimaryAnchor(selectedEvent);

  return {
    decision: 'select',
    candidate_type: selectedEvent.source === 'github' ? 'ship_update' : 'work_update',
    angle: `Scheduled fallback: ${primaryAnchor}`,
    why_interesting: 'Scheduled runs should still surface the strongest recent work instead of silently skipping.',
    source_event_ids: [selectedEvent.id],
    artifact_ids: selectedEvent.artifacts.map((artifact) => artifact.id),
    primary_anchor: primaryAnchor,
    supporting_points: buildFallbackSupportingPoints(selectedEvent, primaryAnchor, skipReason),
    quote_target: null,
    suggested_media_kind: null,
    suggested_media_request: null,
  };
}

type CandidateSourceLinkInput = {
  eventId: number;
  artifactId: number | null;
};

function buildCandidateSourceLinks(
  events: readonly ContextEvent[],
  artifacts: readonly ContextArtifact[],
): CandidateSourceLinkInput[] {
  const links = new Map<string, CandidateSourceLinkInput>();

  for (const event of events) {
    links.set(`event:${String(event.id)}`, {
      eventId: event.id,
      artifactId: null,
    });
  }

  for (const artifact of dedupeArtifacts(artifacts)) {
    links.set(`artifact:${String(artifact.eventId)}:${String(artifact.id)}`, {
      eventId: artifact.eventId,
      artifactId: artifact.id,
    });
  }

  return Array.from(links.values());
}

async function persistCandidateSourceLinks(
  db: Queryable,
  candidateId: string,
  events: readonly ContextEvent[],
  artifacts: readonly ContextArtifact[],
): Promise<void> {
  for (const link of buildCandidateSourceLinks(events, artifacts)) {
    await db.query<CandidateSourceLinkRow>(
      `
        insert into sp_candidate_sources (candidate_id, event_id, artifact_id)
        values ($1, $2, $3)
        on conflict do nothing
      `,
      [candidateId, link.eventId, link.artifactId],
    );
  }
}

export async function selectCandidate({
  db,
  context,
  triggerType,
  fallbackOnSkip = true,
  runSelector,
  hermesBin,
  hermesExecutor,
  xLookupClient,
}: SelectCandidateInput): Promise<SelectCandidateOutcome> {
  const candidatesRepository = createCandidatesRepository(db);
  const selector = buildSelectorRunner({ runSelector, hermesBin, hermesExecutor });
  const selectorDecision = await selector(context);
  const selectorResult =
    selectorDecision.decision === 'skip' && fallbackOnSkip
      ? buildFallbackSelectorPayload(context, selectorDecision.reason) ?? selectorDecision
      : selectorDecision;

  if (selectorResult.decision === 'skip') {
    return {
      outcome: 'skip',
      selectorResult,
      candidate: await candidatesRepository.createCandidate({
        triggerType,
        candidateType: 'skip',
        status: 'selector_skipped',
        selectorOutputJson: selectorResult,
        errorDetails: selectorResult.reason,
      }),
    };
  }

  const selectedEvents = findSelectedEvents(context, selectorResult.source_event_ids);
  const selectedArtifacts = findSelectedArtifacts(selectedEvents, selectorResult.artifact_ids);
  const quoteTargetEnrichment: EnrichedQuoteTarget | null = null;
  const resolvedQuoteTargetUrl = null;
  const repoLinkUrl = findRelevantGitHubRepoUrl(selectedEvents);
  const candidate = await candidatesRepository.createCandidate({
    triggerType,
    candidateType: selectorResult.candidate_type,
    status: 'drafting',
    selectorOutputJson: selectorResult,
    quoteTargetUrl: resolvedQuoteTargetUrl,
    mediaRequest: selectorResult.suggested_media_request,
  });

  try {
    await persistCandidateSourceLinks(db, candidate.id, selectedEvents, selectedArtifacts);
  } catch (error) {
    await candidatesRepository.transitionStatus({
      id: candidate.id,
      fromStatuses: ['drafting'],
      toStatus: 'selector_skipped',
      errorDetails: formatError(error),
    });
    throw error;
  }

  return {
    outcome: 'select',
    candidate,
    selectorResult,
    selectedPacket: {
      kind: 'selected_candidate',
      candidateId: candidate.id,
      triggerType,
      contextWindow: {
        generatedAt: context.generatedAt,
        windowStart: context.windowStart,
        windowEnd: context.windowEnd,
      },
      recentPublishedPosts: context.recentPublishedPosts,
      selection: {
        candidateType: selectorResult.candidate_type,
        angle: selectorResult.angle,
        whyInteresting: selectorResult.why_interesting,
        sourceEventIds: selectorResult.source_event_ids,
        artifactIds: selectorResult.artifact_ids,
        primaryAnchor: selectorResult.primary_anchor,
        supportingPoints: selectorResult.supporting_points,
        quoteTargetUrl: resolvedQuoteTargetUrl,
        suggestedMediaKind: selectorResult.suggested_media_kind,
        suggestedMediaRequest: selectorResult.suggested_media_request,
      },
      events: selectedEvents,
      artifacts: selectedArtifacts,
      quoteTargetEnrichment,
      repoLinkUrl,
    },
  };
}
