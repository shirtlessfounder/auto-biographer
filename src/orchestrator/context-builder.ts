import type { Queryable } from '../db/pool';
import type { NormalizedEventSource } from '../normalization/types';

const DEFAULT_LOOKBACK_HOURS = 16;
const DEFAULT_RECENT_PUBLISHED_POSTS_LIMIT = 5;
const DEFAULT_PENDING_APPROVAL_CANDIDATES_LIMIT = 5;
const ACTIVE_PENDING_APPROVAL_STATUSES = ['pending_approval', 'reminded', 'held'] as const;
const MAX_CONTEXT_EVENT_RAW_TEXT_CHARS = 2000;
const MAX_CONTEXT_ARTIFACT_TEXT_CHARS = 600;
const MAX_CONTEXT_ARTIFACTS_PER_EVENT = 12;

const CONTEXT_SOURCES: readonly NormalizedEventSource[] = [
  'slack_message',
  'slack_link',
  'agent_conversation',
  'github',
];

type EventRow = {
  id: string;
  source: NormalizedEventSource;
  source_id: string;
  occurred_at: Date;
  author: string | null;
  url_or_locator: string | null;
  title: string | null;
  summary: string | null;
  raw_text: string | null;
  tags: unknown;
  artifact_refs: unknown;
  raw_payload: unknown;
};

type ArtifactRow = {
  id: string;
  event_id: string;
  artifact_type: string;
  artifact_key: string;
  content_text: string | null;
  content_json: unknown;
  source_url: string | null;
};

type PublishedPostRow = {
  id: string;
  candidate_id: string;
  posted_at: Date;
  post_type: string;
  final_text: string;
  quote_target_url: string | null;
  media_attached: boolean;
};

type PendingApprovalCandidateRow = {
  id: string;
  status: string;
  candidate_type: string;
  created_at: Date;
  final_post_text: string | null;
  quote_target_url: string | null;
  media_request: string | null;
};

export type ContextArtifact = {
  id: number;
  eventId: number;
  artifactType: string;
  artifactKey: string;
  contentText: string | null;
  contentJson: unknown;
  sourceUrl: string | null;
};

export type ContextEvent = {
  id: number;
  source: NormalizedEventSource;
  sourceId: string;
  occurredAt: string;
  author: string | null;
  urlOrLocator: string | null;
  title: string | null;
  summary: string | null;
  rawText: string | null;
  tags: unknown;
  artifactRefs: unknown;
  rawPayload: unknown;
  artifacts: ContextArtifact[];
};

export type RecentPublishedPostSummary = {
  id: number;
  candidateId: number;
  postedAt: string;
  postType: string;
  finalText: string;
  quoteTargetUrl: string | null;
  mediaAttached: boolean;
};

export type PendingApprovalCandidateSummary = {
  id: number;
  status: string;
  candidateType: string;
  createdAt: string;
  finalPostText: string | null;
  quoteTargetUrl: string | null;
  mediaRequest: string | null;
};

export type RecentContextPacket = {
  kind: 'recent_context';
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  events: ContextEvent[];
  recentPublishedPosts: RecentPublishedPostSummary[];
  pendingApprovalCandidates: PendingApprovalCandidateSummary[];
};

export type BuildRecentContextPacketInput = {
  db: Queryable;
  now?: (() => Date) | undefined;
  lookbackHours?: number | undefined;
  recentPublishedPostsLimit?: number | undefined;
  pendingApprovalCandidatesLimit?: number | undefined;
};

function parseDbId(value: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer database id, received ${value}`);
  }

  return parsed;
}

function subtractHours(value: Date, hours: number): Date {
  return new Date(value.getTime() - hours * 60 * 60 * 1000);
}

function truncateContextText(value: string | null, maxLength: number): string | null {
  if (!value) {
    return value;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function mapArtifactRow(row: ArtifactRow): ContextArtifact {
  return {
    id: parseDbId(row.id),
    eventId: parseDbId(row.event_id),
    artifactType: row.artifact_type,
    artifactKey: row.artifact_key,
    contentText: truncateContextText(row.content_text, MAX_CONTEXT_ARTIFACT_TEXT_CHARS),
    contentJson: row.content_json,
    sourceUrl: row.source_url,
  };
}

function mapPublishedPostRow(row: PublishedPostRow): RecentPublishedPostSummary {
  return {
    id: parseDbId(row.id),
    candidateId: parseDbId(row.candidate_id),
    postedAt: row.posted_at.toISOString(),
    postType: row.post_type,
    finalText: row.final_text,
    quoteTargetUrl: row.quote_target_url,
    mediaAttached: row.media_attached,
  };
}

function mapPendingApprovalCandidateRow(row: PendingApprovalCandidateRow): PendingApprovalCandidateSummary {
  return {
    id: parseDbId(row.id),
    status: row.status,
    candidateType: row.candidate_type,
    createdAt: row.created_at.toISOString(),
    finalPostText: row.final_post_text,
    quoteTargetUrl: row.quote_target_url,
    mediaRequest: row.media_request,
  };
}

function limitArtifactsForContext(artifacts: readonly ContextArtifact[]): ContextArtifact[] {
  if (artifacts.length <= MAX_CONTEXT_ARTIFACTS_PER_EVENT) {
    return [...artifacts];
  }

  const headCount = Math.ceil(MAX_CONTEXT_ARTIFACTS_PER_EVENT / 2);
  const tailCount = MAX_CONTEXT_ARTIFACTS_PER_EVENT - headCount;
  const selected = [...artifacts.slice(0, headCount), ...artifacts.slice(-tailCount)];
  const deduped = new Map<number, ContextArtifact>();

  for (const artifact of selected) {
    deduped.set(artifact.id, artifact);
  }

  return Array.from(deduped.values());
}

export async function buildRecentContextPacket({
  db,
  now = () => new Date(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  recentPublishedPostsLimit = DEFAULT_RECENT_PUBLISHED_POSTS_LIMIT,
  pendingApprovalCandidatesLimit = DEFAULT_PENDING_APPROVAL_CANDIDATES_LIMIT,
}: BuildRecentContextPacketInput): Promise<RecentContextPacket> {
  const windowEnd = now();
  const windowStart = subtractHours(windowEnd, lookbackHours);

  const eventsResult = await db.query<EventRow>(
    `
      select
        id,
        source,
        source_id,
        occurred_at,
        author,
        url_or_locator,
        title,
        summary,
        raw_text,
        tags,
        artifact_refs,
        raw_payload
      from sp_events
      where source = any($1::text[])
        and occurred_at >= $2
        and occurred_at <= $3
        and not exists (
          select 1
          from sp_source_usage source_usage
          where source_usage.event_id = sp_events.id
        )
      order by occurred_at desc, id desc
    `,
    [CONTEXT_SOURCES, windowStart, windowEnd],
  );
  const eventIds = eventsResult.rows.map((row) => row.id);
  const artifactsByEventId = new Map<number, ContextArtifact[]>();

  if (eventIds.length > 0) {
    const artifactsResult = await db.query<ArtifactRow>(
      `
        select
          id,
          event_id,
          artifact_type,
          artifact_key,
          content_text,
          content_json,
          source_url
        from sp_artifacts
        where event_id = any($1::bigint[])
          and not exists (
            select 1
            from sp_source_usage source_usage
            where source_usage.artifact_id = sp_artifacts.id
          )
        order by event_id asc, id asc
      `,
      [eventIds],
    );

    for (const artifactRow of artifactsResult.rows) {
      const artifact = mapArtifactRow(artifactRow);
      const existing = artifactsByEventId.get(artifact.eventId) ?? [];
      existing.push(artifact);
      artifactsByEventId.set(artifact.eventId, existing);
    }
  }

  const recentPublishedPostsResult = await db.query<PublishedPostRow>(
    `
      select
        id,
        candidate_id,
        posted_at,
        post_type,
        final_text,
        quote_target_url,
        media_attached
      from sp_published_posts
      order by posted_at desc, id desc
      limit $1
    `,
    [recentPublishedPostsLimit],
  );
  const pendingApprovalCandidatesResult = await db.query<PendingApprovalCandidateRow>(
    `
      select
        id,
        status,
        candidate_type,
        created_at,
        final_post_text,
        quote_target_url,
        media_request
      from sp_post_candidates
      where status = any($1::text[])
      order by created_at desc, id desc
      limit $2
    `,
    [ACTIVE_PENDING_APPROVAL_STATUSES, pendingApprovalCandidatesLimit],
  );

  return {
    kind: 'recent_context',
    generatedAt: windowEnd.toISOString(),
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    events: eventsResult.rows.map((row) => {
      const eventId = parseDbId(row.id);

      return {
        id: eventId,
        source: row.source,
        sourceId: row.source_id,
        occurredAt: row.occurred_at.toISOString(),
        author: row.author,
        urlOrLocator: row.url_or_locator,
        title: row.title,
        summary: row.summary,
        rawText: truncateContextText(row.raw_text, MAX_CONTEXT_EVENT_RAW_TEXT_CHARS),
        tags: row.tags,
        artifactRefs: row.artifact_refs,
        rawPayload: row.raw_payload,
        artifacts: limitArtifactsForContext(artifactsByEventId.get(eventId) ?? []),
      };
    }),
    recentPublishedPosts: recentPublishedPostsResult.rows.map(mapPublishedPostRow),
    pendingApprovalCandidates: pendingApprovalCandidatesResult.rows.map(mapPendingApprovalCandidateRow),
  };
}
