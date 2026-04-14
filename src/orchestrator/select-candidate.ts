import { createCandidatesRepository, type CandidateRecord } from '../db/repositories/candidates-repository';
import type { Queryable } from '../db/pool';
import { enrichQuoteTarget, type EnrichedQuoteTarget } from '../enrichment/x/enrich-quote-target';
import type { XThreadLookupClient } from '../enrichment/x/client';
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

function getRawSlackLinkPayload(value: unknown): RawSlackLinkPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  return value as RawSlackLinkPayload;
}

async function enrichSelectedQuoteTarget(
  events: readonly ContextEvent[],
  xLookupClient: XThreadLookupClient | undefined,
): Promise<EnrichedQuoteTarget | null> {
  if (!xLookupClient) {
    return null;
  }

  for (const event of events) {
    if (event.source !== 'slack_link') {
      continue;
    }

    const payload = getRawSlackLinkPayload(event.rawPayload);
    const candidate = {
      canonicalUrl: getString(payload?.canonicalUrl),
      domain: getString(payload?.domain) ?? '',
      finalUrl: getString(payload?.finalUrl),
      id: event.sourceId,
      url:
        getString(payload?.sourceUrl)
        ?? getString(payload?.finalUrl)
        ?? getString(payload?.canonicalUrl)
        ?? event.urlOrLocator
        ?? '',
    };

    if (candidate.domain.length === 0 || candidate.url.length === 0) {
      continue;
    }

    const enriched = await enrichQuoteTarget(candidate, xLookupClient);

    if (enriched) {
      return enriched;
    }
  }

  return null;
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
  runSelector,
  hermesBin,
  hermesExecutor,
  xLookupClient,
}: SelectCandidateInput): Promise<SelectCandidateOutcome> {
  const candidatesRepository = createCandidatesRepository(db);
  const selector = buildSelectorRunner({ runSelector, hermesBin, hermesExecutor });
  const selectorResult = await selector(context);

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
  const quoteTargetEnrichment = await enrichSelectedQuoteTarget(selectedEvents, xLookupClient);
  const resolvedQuoteTargetUrl = selectorResult.quote_target ?? quoteTargetEnrichment?.canonicalUrl ?? null;
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
    },
  };
}
