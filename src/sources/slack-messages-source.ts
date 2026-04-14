import type { Pool, PoolClient } from 'pg';

import { upsertEvents, type UpsertedNormalizedEvent } from '../normalization/upsert-events';
import type { NormalizedEventInput } from '../normalization/types';

type SlackAuthorFilters = {
  authorNames: readonly string[];
  authorUserIds: readonly string[];
};

type SlackMessageRow = Record<string, unknown> & {
  id: unknown;
};

type SlackMessagesSource = {
  sync(): Promise<UpsertedNormalizedEvent[]>;
};

const SLACK_MESSAGE_AUTHOR_NAME_KEYS = [
  'user_name',
  'userName',
  'author_name',
  'authorName',
  'display_name',
  'displayName',
] as const;

const SLACK_MESSAGE_AUTHOR_USER_ID_KEYS = [
  'user_id',
  'userId',
  'author_user_id',
  'authorUserId',
] as const;

const SLACK_MESSAGE_OCCURRED_AT_KEYS = [
  'posted_at',
  'postedAt',
  'created_at',
  'createdAt',
  'sent_at',
  'sentAt',
] as const;

const SLACK_MESSAGE_TIMESTAMP_KEYS = ['message_ts', 'messageTs', 'ts'] as const;

const SLACK_MESSAGE_CHANNEL_NAME_KEYS = ['channel_name', 'channelName'] as const;

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

function matchesSlackMessageAuthor(
  row: Record<string, unknown>,
  filters: SlackAuthorFilters,
): boolean {
  const authorNames = buildAuthorSet(filters.authorNames);
  const authorUserIds = buildAuthorSet(filters.authorUserIds);
  const authorName = getString(row, SLACK_MESSAGE_AUTHOR_NAME_KEYS);
  const authorUserId = getString(row, SLACK_MESSAGE_AUTHOR_USER_ID_KEYS);

  return (
    (authorName !== null && authorNames.has(normalizeAuthorValue(authorName))) ||
    (authorUserId !== null && authorUserIds.has(normalizeAuthorValue(authorUserId)))
  );
}

function normalizeSlackMessageRow(
  row: SlackMessageRow,
  filters: SlackAuthorFilters,
): NormalizedEventInput | null {
  if (!matchesSlackMessageAuthor(row, filters)) {
    return null;
  }

  const sourceId = String(row.id);
  const authorName = getString(row, SLACK_MESSAGE_AUTHOR_NAME_KEYS);
  const authorUserId = getString(row, SLACK_MESSAGE_AUTHOR_USER_ID_KEYS);
  const occurredAt =
    getDate(row, SLACK_MESSAGE_OCCURRED_AT_KEYS) ??
    parseSlackTimestamp(getString(row, SLACK_MESSAGE_TIMESTAMP_KEYS));

  if (!occurredAt) {
    throw new Error(`Slack message ${sourceId} is missing an occurred-at timestamp`);
  }

  const rawText = getString(row, ['text', 'message_text', 'messageText']);
  const permalink = getString(row, ['permalink', 'message_permalink', 'messagePermalink', 'url']);
  const channelName = getString(row, SLACK_MESSAGE_CHANNEL_NAME_KEYS);

  return {
    source: 'slack_message',
    sourceId,
    occurredAt,
    author: authorName ?? authorUserId,
    urlOrLocator: permalink,
    rawText,
    tags: channelName ? [channelName] : [],
    rawPayload: row.raw_payload ?? row.rawPayload ?? null,
  };
}

export function createSlackMessagesSource(
  db: Pool | PoolClient,
  filters: SlackAuthorFilters,
): SlackMessagesSource {
  return {
    async sync(): Promise<UpsertedNormalizedEvent[]> {
      const result = await db.query<SlackMessageRow>('select * from slack_messages order by id asc');
      const events = result.rows
        .map((row) => normalizeSlackMessageRow(row, filters))
        .filter((event): event is NormalizedEventInput => event !== null);

      return upsertEvents(db, events);
    },
  };
}
