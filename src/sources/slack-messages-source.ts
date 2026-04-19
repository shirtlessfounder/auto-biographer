import type { Queryable } from '../db/pool';
import { upsertEvents, type UpsertedNormalizedEvent } from '../normalization/upsert-events';
import type { NormalizedEventInput } from '../normalization/types';

type SlackAuthorFilters = {
  authorNames: readonly string[];
  authorUserIds: readonly string[];
  lookbackHours?: number;
};

type SlackMessageRow = {
  id: number;
  channel_id: string;
  channel_name: string;
  message_ts: string;
  user_id: string | null;
  user_name: string | null;
  text: string | null;
  thread_ts: string | null;
  posted_at: Date;
  synced_at: Date | null;
};

function normalizeAuthorValue(value: string): string {
  return value.trim().toLowerCase();
}

function buildAuthorSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeAuthorValue).filter((v) => v.length > 0));
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function decodeSlackRow(row: SlackMessageRow): SlackMessageRow {
  return {
    ...row,
    text: row.text ? decodeHtmlEntities(row.text) : row.text,
    channel_name: row.channel_name ? decodeHtmlEntities(row.channel_name) : row.channel_name,
    user_name: row.user_name ? decodeHtmlEntities(row.user_name) : row.user_name,
  };
}

function matchesAuthor(
  userId: string | null,
  userName: string | null,
  filters: SlackAuthorFilters,
): boolean {
  const filterIds = buildAuthorSet(filters.authorUserIds);
  const filterNames = buildAuthorSet(filters.authorNames);

  // If no filters, pass all
  if (filterIds.size === 0 && filterNames.size === 0) return true;

  if (userId && filterIds.has(normalizeAuthorValue(userId))) return true;
  if (userName && filterNames.has(normalizeAuthorValue(userName))) return true;

  return false;
}

const LOAD_MESSAGES_SQL = `
  SELECT json_agg(
    json_build_object(
      'id', id,
      'channel_id', channel_id,
      'channel_name', channel_name,
      'message_ts', message_ts,
      'user_id', user_id,
      'user_name', user_name,
      'text', text,
      'thread_ts', thread_ts,
      'posted_at', posted_at,
      'synced_at', synced_at
    )
  )::text AS _json
  FROM (
    SELECT id, channel_id, channel_name, message_ts, user_id, user_name,
           text, thread_ts, posted_at, synced_at
    FROM slack_messages
    WHERE posted_at >= now() - ($1::integer * interval '1 hour')
    ORDER BY posted_at ASC
  ) _rows
`;

export function createSlackMessagesSource(
  db: Queryable,
  filters: SlackAuthorFilters,
) {
  return {
    async sync(): Promise<UpsertedNormalizedEvent[]> {
      const lookback = filters.lookbackHours ?? 24;

      // Wrap in a sub-SELECT so the MCP client adds its outer json_agg wrapper.
      // We then unwrap the double-nesting: MCP returns [{_json: "[inner_array]"}]
      // → extract inner_array → parse → use rows directly.
      const result = await db.query<{ _json: string }>(
        `SELECT * FROM (${LOAD_MESSAGES_SQL}) _outer`,
        [lookback],
      );

      let rows: SlackMessageRow[] = [];
      if (result.rows.length > 0 && result.rows[0]._json !== undefined) {
        try {
          // Single-wrapped: [{'_json': '[{row1}, {row2}, ...]'}] or raw object rows
          const rawRows = result.rows[0]._json;
          if (typeof rawRows === 'string') {
            rows = (JSON.parse(rawRows) as SlackMessageRow[]).map(decodeSlackRow);
          } else if (Array.isArray(rawRows)) {
            rows = (rawRows as SlackMessageRow[]).map(decodeSlackRow);
          } else if (typeof rawRows === 'object' && rawRows !== null) {
            rows = [decodeSlackRow(rawRows as SlackMessageRow)];
          }
        } catch (e) {
          console.error(`[slack-messages] failed to parse _json: ${(e as Error).message}`);
        }
      }

      if (result.rows.length > 0 && result.rows[0]._json !== undefined) {
        try {
          const rawVal = result.rows[0]._json;
          console.error(`[slack-messages] _json type=${typeof rawVal}, isArray=${Array.isArray(rawVal)}, isString=${typeof rawVal === 'string'}, first200=${typeof rawVal === 'string' ? (rawVal as string).slice(0,200) : String(rawVal).slice(0,200)}`);
        } catch (e) { console.error(`[slack-messages] debug error: ${(e as Error).message}`); }
      }

      console.error(`[slack-messages] ${rows.length} rows from DB, lookback=${lookback}h, userIds=${filters.authorUserIds}`);
      if (rows.length === 0 && result.rows.length > 0) {
        console.error(`[slack-messages] first row keys: ${Object.keys(result.rows[0]!).join(', ')}`);
      }

      const events: NormalizedEventInput[] = [];

      for (const row of rows) {
        if (!matchesAuthor(row.user_id, row.user_name, filters)) continue;

        const sourceId = `slack_msg:${row.id}`;

        events.push({
          source: 'slack_message',
          sourceId,
          occurredAt: new Date(row.posted_at),
          author: row.user_name ?? row.user_id ?? 'unknown',
          urlOrLocator: null,
          title: row.text ? row.text.slice(0, 120) : '(no text)',
          rawText: row.text,
          tags: [row.channel_name],
          rawPayload: {
            messageId: row.id,
            channelId: row.channel_id,
            channelName: row.channel_name,
            userId: row.user_id,
            userName: row.user_name,
            messageTs: row.message_ts,
            threadTs: row.thread_ts,
            postedAt: new Date(row.posted_at).toISOString(),
            syncedAt: row.synced_at ? new Date(row.synced_at).toISOString() : null,
          },
          artifacts: [],
        });
      }

      console.error(`[slack-messages] ${events.length} events after author filter`);
      return upsertEvents(db, events);
    },
  };
}
