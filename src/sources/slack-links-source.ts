import type { Pool } from 'pg';
import type { Queryable } from '../db/pool';

import { upsertEvents, type UpsertedNormalizedEvent } from '../normalization/upsert-events';
import type { NormalizedArtifactInput, NormalizedEventInput } from '../normalization/types';

type SlackAuthorFilters = {
  authorNames: readonly string[];
  authorUserIds: readonly string[];
  lookbackHours?: number;
};

type SlackLinkRow = Record<string, unknown> & {
  id: unknown;
};

type SlackLinksSource = {
  sync(): Promise<UpsertedNormalizedEvent[]>;
};

const LOAD_SLACK_LINKS_SQL = `
  select id, url, canonical_url, final_url, domain, adapter, status, title, author,
    published_at,
    http_status, content_type, first_seen_at, captured_at,
    slack_team_id, slack_channel_id, slack_channel_name, slack_user_id,
    slack_message_ts, slack_permalink, error_code, error_message, created_at, updated_at
  from sl_links
  where (
    $1::integer is null
    or coalesce(first_seen_at, captured_at) >= now() - ($1::integer * interval '1 hour')
  )
  order by id asc
`;

const SLACK_LINK_AUTHOR_NAME_KEYS = [
  'slack_user_name',
  'slackUserName',
  'slack_author_name',
  'slackAuthorName',
] as const;

const SLACK_LINK_AUTHOR_USER_ID_KEYS = [
  'slack_user_id',
  'slackUserId',
  'author_user_id',
  'authorUserId',
] as const;

const SLACK_LINK_OCCURRED_AT_KEYS = [
  'first_seen_at',
  'firstSeenAt',
  'captured_at',
  'capturedAt',
  'created_at',
  'createdAt',
] as const;

const SLACK_LINK_MESSAGE_TIMESTAMP_KEYS = ['slack_message_ts', 'slackMessageTs'] as const;

function normalizeAuthorValue(value: string): string {
  return value.trim().toLowerCase();
}

function buildAuthorSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeAuthorValue).filter((value) => value.length > 0));
}

function getString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];

    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0) {
      continue;
    }

    return trimmed;
  }

  return null;
}

function getDate(row: Record<string, unknown>, keys: readonly string[]): Date | null {
  for (const key of keys) {
    const value = row[key];

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value);

      if (!Number.isNaN(date.getTime())) {
        return date;
      }
    }
  }

  return null;
}

function parseSlackTimestamp(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  return new Date(numeric * 1000);
}

function matchesSlackLinkAuthor(
  row: Record<string, unknown>,
  filters: SlackAuthorFilters,
): boolean {
  const authorNames = buildAuthorSet(filters.authorNames);
  const authorUserIds = buildAuthorSet(filters.authorUserIds);
  const hasAuthorFilter = authorNames.size > 0 || authorUserIds.size > 0;

  if (!hasAuthorFilter) {
    return true; // no filter → pass all
  }

  const authorName = getString(row, SLACK_LINK_AUTHOR_NAME_KEYS);
  const authorUserId = getString(row, SLACK_LINK_AUTHOR_USER_ID_KEYS);

  return (
    (authorName !== null && authorNames.has(normalizeAuthorValue(authorName))) ||
    (authorUserId !== null && authorUserIds.has(normalizeAuthorValue(authorUserId)))
  );
}

function buildSlackLinkArtifacts(row: Record<string, unknown>, sourceUrl: string | null): NormalizedArtifactInput[] {
  const artifacts: NormalizedArtifactInput[] = [];
  const normalizedMarkdown = getString(row, ['normalized_markdown', 'normalizedMarkdown']);
  const readableText = getString(row, ['readable_text', 'readableText']);
  const rawPayload = row.raw_payload ?? row.rawPayload;

  if (normalizedMarkdown !== null) {
    artifacts.push({
      artifactType: 'text',
      artifactKey: 'captured_markdown',
      contentText: normalizedMarkdown,
      sourceUrl,
    });
  }

  if (readableText !== null) {
    artifacts.push({
      artifactType: 'text',
      artifactKey: 'captured_text',
      contentText: readableText,
      sourceUrl,
    });
  }

  if (rawPayload !== undefined && rawPayload !== null) {
    artifacts.push({
      artifactType: 'json',
      artifactKey: 'captured_raw_payload',
      contentJson: rawPayload,
      sourceUrl,
    });
  }

  return artifacts;
}

function normalizeSlackLinkRow(row: SlackLinkRow, filters: SlackAuthorFilters): NormalizedEventInput | null {
  if (!matchesSlackLinkAuthor(row, filters)) {
    return null;
  }

  const sourceId = String(row.id);
  const sourceUrl = getString(row, ['canonical_url', 'canonicalUrl']);
  const originalUrl = getString(row, ['url']);
  const finalUrl = getString(row, ['final_url', 'finalUrl']);
  const domain = getString(row, ['domain']);
  const slackPermalink = getString(row, ['slack_permalink', 'slackPermalink']);
  const occurredAt =
    getDate(row, SLACK_LINK_OCCURRED_AT_KEYS) ??
    parseSlackTimestamp(getString(row, SLACK_LINK_MESSAGE_TIMESTAMP_KEYS));

  if (!occurredAt) {
    throw new Error(`Slack link ${sourceId} is missing an occurred-at timestamp`);
  }

  const authorName = getString(row, SLACK_LINK_AUTHOR_NAME_KEYS);
  const authorUserId = getString(row, SLACK_LINK_AUTHOR_USER_ID_KEYS);

  return {
    source: 'slack_link',
    sourceId,
    occurredAt,
    author: authorName ?? authorUserId,
    urlOrLocator: sourceUrl ?? finalUrl ?? originalUrl ?? slackPermalink,
    title: getString(row, ['title']),
    rawText: getString(row, ['readable_text', 'readableText', 'normalized_markdown', 'normalizedMarkdown']),
    tags: domain ? [domain] : [],
    rawPayload: {
      sourceUrl: originalUrl ?? sourceUrl ?? finalUrl ?? null,
      canonicalUrl: sourceUrl,
      finalUrl,
      domain,
      slackPermalink,
    },
    artifacts: buildSlackLinkArtifacts(row, sourceUrl ?? finalUrl ?? originalUrl ?? slackPermalink),
  };
}

export function createSlackLinksSource(
  db: Queryable,
  filters: SlackAuthorFilters,
): SlackLinksSource {
  return {
    async sync(): Promise<UpsertedNormalizedEvent[]> {
      const result = await db.query<SlackLinkRow>(LOAD_SLACK_LINKS_SQL, [filters.lookbackHours ?? null]);
      console.error(`[slack-links] query returned ${result.rowCount} rows, lookbackHours=${filters.lookbackHours}, authorUserIds=${filters.authorUserIds}`);
      const events = result.rows
        .map((row) => normalizeSlackLinkRow(row, filters))
        .filter((event): event is NormalizedEventInput => event !== null);

      return upsertEvents(db, events);
    },
  };
}
