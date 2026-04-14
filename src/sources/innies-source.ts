import { gunzipSync } from 'node:zlib';

import type { Pool, PoolClient } from 'pg';

import { upsertEvents, type UpsertedNormalizedEvent } from '../normalization/upsert-events';
import type { NormalizedArtifactInput, NormalizedEventInput } from '../normalization/types';

type InniesSource = {
  sync(): Promise<UpsertedNormalizedEvent[]>;
};

type InniesSourceOptions = {
  buyerKeyName: string;
  lookbackHours?: number;
};

type InniesConversationRow = {
  buyer_key_name: string;
  session_key: string;
  session_type: string;
  started_at: Date;
  ended_at: Date;
  last_activity_at: Date;
  request_count: number | string;
  attempt_count: number | string;
  request_attempt_archive_id: string;
  request_id: string;
  attempt_no: number;
  event_time: Date;
  sequence_no: number;
  provider: string;
  model: string;
  attempt_status: string;
  side: 'request' | 'response';
  ordinal: number;
  message_role: string | null;
  normalized_payload: unknown;
  raw_blob_encoding: 'gzip' | 'none' | null;
  raw_blob_payload: Buffer | null;
};

type ConversationMessage = {
  artifactKey: string;
  requestAttemptArchiveId: string;
  requestId: string;
  attemptNo: number;
  provider: string;
  model: string;
  side: 'request' | 'response';
  ordinal: number;
  role: string;
  excerpt: string;
  usedRawFallback: boolean;
};

type SessionAccumulator = {
  buyerKeyName: string;
  sessionKey: string;
  sessionType: string;
  startedAt: Date;
  endedAt: Date;
  lastActivityAt: Date;
  requestCount: number;
  attemptCount: number;
  rows: InniesConversationRow[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function sortUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0))).sort((left, right) =>
    left.localeCompare(right),
  );
}

function stringifyCompact(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return readString(value);
  }

  try {
    const serialized = JSON.stringify(value);
    return readString(serialized);
  } catch {
    return null;
  }
}

function normalizeText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isSseNoiseLine(line))
    .join('\n')
    .trim();

  return normalized.length > 0 ? normalized : null;
}

function isSseNoiseLine(value: string): boolean {
  return value === '[DONE]'
    || value.startsWith(':')
    || value.startsWith('event:')
    || value.startsWith('id:')
    || value.startsWith('retry:');
}

function collectUnknownText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    const normalized = normalizeText(value);

    if (normalized) {
      output.push(normalized);
    }

    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectUnknownText(item, output));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  for (const key of ['text', 'output_text', 'input_text']) {
    collectUnknownText(value[key], output);
  }

  for (const key of ['delta', 'content', 'message', 'messages', 'output', 'response', 'item']) {
    collectUnknownText(value[key], output);
  }
}

function parseSseText(rawText: string): string | null {
  if (!rawText.includes('data:')) {
    return null;
  }

  const output: string[] = [];

  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed.startsWith('data:')) {
      continue;
    }

    const payload = trimmed.slice(5).trim();

    if (!payload || payload === '[DONE]') {
      continue;
    }

    try {
      collectUnknownText(JSON.parse(payload), output);
    } catch {
      const normalized = normalizeText(payload);

      if (normalized) {
        output.push(normalized);
      }
    }
  }

  return readString(output.join('\n'));
}

function extractRawFallbackText(encoding: 'gzip' | 'none' | null, payload: Buffer | null): string | null {
  if (!encoding || !payload) {
    return null;
  }

  const decoded = encoding === 'gzip' ? gunzipSync(payload) : Buffer.from(payload);
  const rawText = decoded.toString('utf8');
  const sseText = parseSseText(rawText);

  if (sseText) {
    return sseText;
  }

  const jsonTextParts: string[] = [];

  try {
    collectUnknownText(JSON.parse(rawText), jsonTextParts);
  } catch {
    return normalizeText(rawText);
  }

  return readString(jsonTextParts.join('\n')) ?? normalizeText(rawText);
}

function extractNormalizedExcerpt(normalizedPayload: unknown, fallbackRole: string | null): string | null {
  if (!isRecord(normalizedPayload)) {
    return null;
  }

  const payloadRole = readString(normalizedPayload.role) ?? fallbackRole;
  const content = Array.isArray(normalizedPayload.content) ? normalizedPayload.content : [];
  const fragments: string[] = [];

  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }

    if (part.type === 'text') {
      const text = normalizeText(readString(part.text));

      if (text) {
        fragments.push(text);
      }

      continue;
    }

    if (part.type === 'tool_call') {
      const toolName = readString(part.name) ?? 'tool';
      const serializedArguments = stringifyCompact(part.arguments);
      fragments.push(serializedArguments ? `tool_call ${toolName}: ${serializedArguments}` : `tool_call ${toolName}`);
      continue;
    }

    if (part.type === 'tool_result') {
      const serializedContent = stringifyCompact(part.content);

      if (serializedContent) {
        fragments.push(`tool_result: ${serializedContent}`);
      }

      continue;
    }

    if (part.type === 'json') {
      const serializedValue = stringifyCompact(part.value);

      if (serializedValue) {
        fragments.push(serializedValue);
      }
    }
  }

  const excerpt = readString(fragments.join('\n'));

  if (excerpt) {
    return excerpt;
  }

  if (payloadRole === 'assistant' || payloadRole === 'user' || payloadRole === 'system') {
    return null;
  }

  return null;
}

function normalizeConversationMessage(row: InniesConversationRow): ConversationMessage | null {
  const role = readString(row.message_role) ?? (row.side === 'request' ? 'user' : 'assistant');
  const normalizedExcerpt = extractNormalizedExcerpt(row.normalized_payload, role);
  const excerpt = normalizedExcerpt ?? extractRawFallbackText(row.raw_blob_encoding, row.raw_blob_payload);

  if (!excerpt) {
    return null;
  }

  return {
    artifactKey: `${row.request_attempt_archive_id}:${row.side}:${String(row.ordinal)}`,
    requestAttemptArchiveId: row.request_attempt_archive_id,
    requestId: row.request_id,
    attemptNo: row.attempt_no,
    provider: row.provider,
    model: row.model,
    side: row.side,
    ordinal: row.ordinal,
    role,
    excerpt,
    usedRawFallback: normalizedExcerpt === null,
  };
}

function formatTranscriptLine(message: ConversationMessage): string {
  return `${message.role}: ${message.excerpt}`;
}

function truncate(value: string | null, maxLength: number): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function findFirstMessage(
  messages: readonly ConversationMessage[],
  predicate: (message: ConversationMessage) => boolean,
): ConversationMessage | null {
  for (const message of messages) {
    if (predicate(message)) {
      return message;
    }
  }

  return null;
}

function findLastMessage(
  messages: readonly ConversationMessage[],
  predicate: (message: ConversationMessage) => boolean,
): ConversationMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message && predicate(message)) {
      return message;
    }
  }

  return null;
}

function buildArtifacts(
  session: SessionAccumulator,
  messages: readonly ConversationMessage[],
  providerSet: readonly string[],
  modelSet: readonly string[],
): NormalizedArtifactInput[] {
  const artifacts: NormalizedArtifactInput[] = messages.map((message) => ({
    artifactType: 'message_excerpt',
    artifactKey: message.artifactKey,
    contentText: message.excerpt,
    contentJson: {
      requestAttemptArchiveId: message.requestAttemptArchiveId,
      requestId: message.requestId,
      attemptNo: message.attemptNo,
      provider: message.provider,
      model: message.model,
      side: message.side,
      ordinal: message.ordinal,
      role: message.role,
      usedRawFallback: message.usedRawFallback,
    },
  }));

  artifacts.push({
    artifactType: 'session_metadata',
    artifactKey: session.sessionKey,
    contentJson: {
      sessionKey: session.sessionKey,
      sessionType: session.sessionType,
      buyerKeyName: session.buyerKeyName,
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      requestCount: session.requestCount,
      attemptCount: session.attemptCount,
      providerSet,
      modelSet,
    },
  });

  return artifacts;
}

function buildSessionEvent(session: SessionAccumulator): NormalizedEventInput {
  const messages = session.rows
    .map((row) => normalizeConversationMessage(row))
    .filter((message): message is ConversationMessage => message !== null);
  const providerSet = sortUnique(session.rows.map((row) => row.provider));
  const modelSet = sortUnique(session.rows.map((row) => row.model));
  const firstRequest = findFirstMessage(messages, (message) => message.side === 'request');
  const firstMessage = messages[0] ?? null;
  const lastRequest = findLastMessage(messages, (message) => message.side === 'request');
  const lastResponse = findLastMessage(messages, (message) => message.side === 'response');
  const summaryParts = [lastRequest?.excerpt ?? null, lastResponse?.excerpt ?? null].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const rawText = readString(messages.map((message) => formatTranscriptLine(message)).join('\n\n'));

  return {
    source: 'agent_conversation',
    sourceId: session.sessionKey,
    occurredAt: session.lastActivityAt,
    author: session.buyerKeyName,
    urlOrLocator: session.sessionKey,
    title: truncate(firstRequest?.excerpt ?? firstMessage?.excerpt ?? session.sessionKey, 200),
    summary: truncate(summaryParts.join(' | '), 280),
    rawText,
    rawPayload: {
      sessionKey: session.sessionKey,
      messageCount: messages.length,
      providerSet,
      modelSet,
    },
    artifacts: buildArtifacts(session, messages, providerSet, modelSet),
  };
}

function groupRowsBySession(rows: readonly InniesConversationRow[]): SessionAccumulator[] {
  const sessions = new Map<string, SessionAccumulator>();

  for (const row of rows) {
    const existing = sessions.get(row.session_key);

    if (existing) {
      existing.rows.push(row);
      continue;
    }

    sessions.set(row.session_key, {
      buyerKeyName: row.buyer_key_name,
      sessionKey: row.session_key,
      sessionType: row.session_type,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at,
      requestCount: toNumber(row.request_count),
      attemptCount: toNumber(row.attempt_count),
      rows: [row],
    });
  }

  return Array.from(sessions.values());
}

const LOAD_INNIES_ROWS_SQL = `
  select
    k.name as buyer_key_name,
    s.session_key,
    s.session_type,
    s.started_at,
    s.ended_at,
    s.last_activity_at,
    s.request_count,
    s.attempt_count,
    sa.request_attempt_archive_id,
    sa.request_id,
    sa.attempt_no,
    sa.event_time,
    sa.sequence_no,
    sa.provider,
    sa.model,
    sa.status as attempt_status,
    ram.side,
    ram.ordinal,
    ram.role as message_role,
    mb.normalized_payload,
    rb.encoding as raw_blob_encoding,
    rb.payload as raw_blob_payload
  from in_admin_sessions s
  inner join in_api_keys k
    on s.api_key_id = k.id
  inner join in_admin_session_attempts sa
    on sa.session_key = s.session_key
  inner join in_request_attempt_messages ram
    on ram.request_attempt_archive_id = sa.request_attempt_archive_id
  inner join in_message_blobs mb
    on mb.id = ram.message_blob_id
  left join lateral (
    select rab.raw_blob_id
    from in_request_attempt_raw_blobs rab
    where rab.request_attempt_archive_id = sa.request_attempt_archive_id
      and (
        (ram.side = 'request' and rab.blob_role = 'request')
        or (ram.side = 'response' and rab.blob_role in ('response', 'stream'))
      )
    order by
      case rab.blob_role
        when 'request' then 0
        when 'response' then 1
        when 'stream' then 2
        else 3
      end asc
    limit 1
  ) raw_link
    on true
  left join in_raw_blobs rb
    on rb.id = raw_link.raw_blob_id
  where k.name = $1
    and (
      $2::integer is null
      or s.last_activity_at >= now() - ($2::integer * interval '1 hour')
    )
  order by
    s.last_activity_at asc,
    s.session_key asc,
    sa.event_time asc,
    sa.request_id asc,
    sa.attempt_no asc,
    sa.sequence_no asc,
    case ram.side when 'request' then 0 when 'response' then 1 else 2 end asc,
    ram.ordinal asc
`;

export function createInniesSource(
  db: Pool | PoolClient,
  options: InniesSourceOptions,
): InniesSource {
  return {
    async sync(): Promise<UpsertedNormalizedEvent[]> {
      const result = await db.query<InniesConversationRow>(LOAD_INNIES_ROWS_SQL, [
        options.buyerKeyName,
        options.lookbackHours ?? null,
      ]);
      const events = groupRowsBySession(result.rows).map((session) => buildSessionEvent(session));

      return upsertEvents(db, events);
    },
  };
}
