import type { Queryable } from '../db/pool';
import type { NormalizedEventSource } from '../normalization/types';

const DEFAULT_LOOKBACK_HOURS = 12;
const DEFAULT_RECENT_PUBLISHED_POSTS_LIMIT = 5;

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

export type RecentContextPacket = {
  kind: 'recent_context';
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  events: ContextEvent[];
  recentPublishedPosts: RecentPublishedPostSummary[];
};

export type BuildRecentContextPacketInput = {
  db: Queryable;
  now?: (() => Date) | undefined;
  lookbackHours?: number | undefined;
  recentPublishedPostsLimit?: number | undefined;
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

function mapArtifactRow(row: ArtifactRow): ContextArtifact {
  return {
    id: parseDbId(row.id),
    eventId: parseDbId(row.event_id),
    artifactType: row.artifact_type,
    artifactKey: row.artifact_key,
    contentText: row.content_text,
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

export async function buildRecentContextPacket({
  db,
  now = () => new Date(),
  lookbackHours = DEFAULT_LOOKBACK_HOURS,
  recentPublishedPostsLimit = DEFAULT_RECENT_PUBLISHED_POSTS_LIMIT,
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
        rawText: row.raw_text,
        tags: row.tags,
        artifactRefs: row.artifact_refs,
        rawPayload: row.raw_payload,
        artifacts: artifactsByEventId.get(eventId) ?? [],
      };
    }),
    recentPublishedPosts: recentPublishedPostsResult.rows.map(mapPublishedPostRow),
  };
}
