import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/db/migrate';
import { createPool } from '../../../src/db/pool';
import { createInniesSource } from '../../../src/sources/innies-source';

const execFileAsync = promisify(execFile);

type TestDatabase = {
  dataDirectory: string;
  pool: Pool;
};

async function allocatePort(): Promise<number> {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate a TCP port for the test database');
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return address.port;
}

async function getPostgresBinDirectory(): Promise<string> {
  const { stdout } = await execFileAsync('pg_config', ['--bindir'], { encoding: 'utf8' });
  const candidates = [
    process.env.POSTGRES_BIN_DIR,
    '/opt/homebrew/opt/postgresql@18/bin',
    stdout.trim(),
  ].filter((value): value is string => value !== undefined && value.length > 0);

  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, 'postgres'));
      await access(path.join(candidate, 'initdb'));
      await access(path.join(candidate, 'pg_ctl'));
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error('Could not find a Postgres server binary directory');
}

async function createTestDatabase(): Promise<TestDatabase> {
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'auto-biographer-innies-source-'));
  const dataDirectory = path.join(baseDirectory, 'data');
  const logFilePath = path.join(baseDirectory, 'postgres.log');
  const port = await allocatePort();
  const bindir = await getPostgresBinDirectory();
  const initdb = path.join(bindir, 'initdb');
  const pgCtl = path.join(bindir, 'pg_ctl');

  await mkdir(dataDirectory, { recursive: true });
  await execFileAsync(initdb, ['-D', dataDirectory, '-A', 'trust', '-U', process.env.USER ?? 'postgres']);
  await execFileAsync(pgCtl, [
    '-D',
    dataDirectory,
    '-l',
    logFilePath,
    '-o',
    `-h 127.0.0.1 -p ${String(port)} -k ${baseDirectory}`,
    '-w',
    'start',
  ]);

  const pool = createPool(
    `postgres://${encodeURIComponent(process.env.USER ?? 'postgres')}@127.0.0.1:${String(port)}/postgres`,
  );

  await pool.query('select 1');

  return {
    dataDirectory,
    pool,
  };
}

async function stopTestDatabase(database: TestDatabase): Promise<void> {
  const bindir = await getPostgresBinDirectory();
  const pgCtl = path.join(bindir, 'pg_ctl');

  await database.pool.end();
  await execFileAsync(pgCtl, ['-D', database.dataDirectory, '-w', 'stop', '-m', 'immediate']);
  await rm(path.dirname(database.dataDirectory), { force: true, recursive: true });
}

async function resetSchema(pool: Pool): Promise<void> {
  await pool.query(`
    drop schema public cascade;
    create schema public;
  `);
}

async function createInniesTables(pool: Pool): Promise<void> {
  await pool.query(`
    create table in_api_keys (
      id uuid primary key,
      name text not null
    );

    create table in_admin_sessions (
      session_key text primary key,
      api_key_id uuid references in_api_keys(id) on delete cascade,
      session_type text not null,
      started_at timestamptz not null,
      ended_at timestamptz not null,
      last_activity_at timestamptz not null,
      request_count integer not null default 0,
      attempt_count integer not null default 0
    );

    create table in_admin_session_attempts (
      session_key text not null references in_admin_sessions(session_key) on delete cascade,
      request_attempt_archive_id uuid not null,
      request_id text not null,
      attempt_no integer not null,
      event_time timestamptz not null,
      sequence_no integer not null,
      provider text not null,
      model text not null,
      status text not null,
      primary key (session_key, request_attempt_archive_id)
    );

    create table in_message_blobs (
      id uuid primary key,
      normalized_payload jsonb not null
    );

    create table in_request_attempt_messages (
      request_attempt_archive_id uuid not null,
      side text not null,
      ordinal integer not null,
      message_blob_id uuid not null references in_message_blobs(id) on delete cascade,
      role text,
      content_type text not null,
      created_at timestamptz not null default now(),
      primary key (request_attempt_archive_id, side, ordinal)
    );

    create table in_raw_blobs (
      id uuid primary key,
      encoding text not null,
      payload bytea not null
    );

    create table in_request_attempt_raw_blobs (
      request_attempt_archive_id uuid not null,
      blob_role text not null,
      raw_blob_id uuid not null references in_raw_blobs(id) on delete cascade,
      primary key (request_attempt_archive_id, blob_role)
    );
  `);
}

function message(role: 'system' | 'user' | 'assistant', text: string) {
  return JSON.stringify({
    role,
    content: [
      {
        type: 'text',
        text,
      },
    ],
  });
}

function emptyAssistantMessage() {
  return JSON.stringify({
    role: 'assistant',
    content: [],
  });
}

describe('createInniesSource', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    await resetSchema(database.pool);
    await runMigrations(database.pool);
    await createInniesTables(database.pool);
  });

  afterAll(async () => {
    if (database) {
      await stopTestDatabase(database);
    }
  });

  it('filters by buyer key, collapses one session into one event, and persists excerpts plus metadata artifacts', async () => {
    await database.pool.query(
      `
        insert into in_api_keys (id, name)
        values
          ($1, $2),
          ($3, $4)
      `,
      [
        '00000000-0000-4000-8000-000000000001',
        'shirtless',
        '00000000-0000-4000-8000-000000000002',
        'not-dylan',
      ],
    );
    await database.pool.query(
      `
        insert into in_admin_sessions (
          session_key,
          api_key_id,
          session_type,
          started_at,
          ended_at,
          last_activity_at,
          request_count,
          attempt_count
        )
        values
          ($1, $2, $3, $4, $5, $6, $7, $8),
          ($9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
        'cli:session:shirtless-1',
        '00000000-0000-4000-8000-000000000001',
        'cli',
        new Date('2026-04-14T10:00:00.000Z'),
        new Date('2026-04-14T10:12:00.000Z'),
        new Date('2026-04-14T10:12:00.000Z'),
        2,
        2,
        'cli:session:someone-else',
        '00000000-0000-4000-8000-000000000002',
        'cli',
        new Date('2026-04-14T11:00:00.000Z'),
        new Date('2026-04-14T11:03:00.000Z'),
        new Date('2026-04-14T11:03:00.000Z'),
        1,
        1,
      ],
    );
    await database.pool.query(
      `
        insert into in_admin_session_attempts (
          session_key,
          request_attempt_archive_id,
          request_id,
          attempt_no,
          event_time,
          sequence_no,
          provider,
          model,
          status
        )
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9),
          ($10, $11, $12, $13, $14, $15, $16, $17, $18),
          ($19, $20, $21, $22, $23, $24, $25, $26, $27)
      `,
      [
        'cli:session:shirtless-1',
        '10000000-0000-4000-8000-000000000001',
        'req-shirtless-1',
        1,
        new Date('2026-04-14T10:01:00.000Z'),
        0,
        'openai',
        'gpt-5.4',
        'success',
        'cli:session:shirtless-1',
        '10000000-0000-4000-8000-000000000002',
        'req-shirtless-2',
        1,
        new Date('2026-04-14T10:11:00.000Z'),
        1,
        'anthropic',
        'claude-opus-4.5',
        'success',
        'cli:session:someone-else',
        '10000000-0000-4000-8000-000000000003',
        'req-someone-else',
        1,
        new Date('2026-04-14T11:02:00.000Z'),
        0,
        'openai',
        'gpt-5.4',
        'success',
      ],
    );
    await database.pool.query(
      `
        insert into in_message_blobs (id, normalized_payload)
        values
          ($1, $2::jsonb),
          ($3, $4::jsonb),
          ($5, $6::jsonb),
          ($7, $8::jsonb),
          ($9, $10::jsonb),
          ($11, $12::jsonb)
      `,
      [
        '20000000-0000-4000-8000-000000000001',
        message('user', 'Ship the Innies adapter.'),
        '20000000-0000-4000-8000-000000000002',
        message('assistant', 'Implemented the first draft.'),
        '20000000-0000-4000-8000-000000000003',
        message('user', 'Add message artifacts too.'),
        '20000000-0000-4000-8000-000000000004',
        message('assistant', 'Confirmed the adapter is emitting artifacts.'),
        '20000000-0000-4000-8000-000000000005',
        message('user', 'Ignore this other session.'),
        '20000000-0000-4000-8000-000000000006',
        message('assistant', 'This should never be imported.'),
      ],
    );
    await database.pool.query(
      `
        insert into in_request_attempt_messages (
          request_attempt_archive_id,
          side,
          ordinal,
          message_blob_id,
          role,
          content_type
        )
        values
          ($1, 'request', 0, $2, 'user', 'text'),
          ($1, 'response', 0, $3, 'assistant', 'text'),
          ($4, 'request', 0, $5, 'user', 'text'),
          ($4, 'response', 0, $6, 'assistant', 'text'),
          ($7, 'request', 0, $8, 'user', 'text'),
          ($7, 'response', 0, $9, 'assistant', 'text')
      `,
      [
        '10000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000001',
        '20000000-0000-4000-8000-000000000002',
        '10000000-0000-4000-8000-000000000002',
        '20000000-0000-4000-8000-000000000003',
        '20000000-0000-4000-8000-000000000004',
        '10000000-0000-4000-8000-000000000003',
        '20000000-0000-4000-8000-000000000005',
        '20000000-0000-4000-8000-000000000006',
      ],
    );

    const source = createInniesSource(database.pool, {
      buyerKeyName: 'shirtless',
    });

    const persisted = await source.sync();
    const events = await database.pool.query<{
      source: string;
      source_id: string;
      occurred_at: Date;
      author: string | null;
      url_or_locator: string | null;
      title: string | null;
      summary: string | null;
      raw_text: string | null;
      artifact_refs: Array<{ artifactType: string; artifactKey: string }>;
      raw_payload: {
        sessionKey: string;
        messageCount: number;
        providerSet: string[];
        modelSet: string[];
      };
    }>(
      `
        select
          source,
          source_id,
          occurred_at,
          author,
          url_or_locator,
          title,
          summary,
          raw_text,
          artifact_refs,
          raw_payload
        from sp_events
        order by source_id
      `,
    );
    const artifacts = await database.pool.query<{
      artifact_type: string;
      artifact_key: string;
      content_text: string | null;
      content_json: unknown;
    }>(
      `
        select artifact_type, artifact_key, content_text, content_json
        from sp_artifacts
        order by artifact_type, artifact_key
      `,
    );

    expect(persisted).toHaveLength(1);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.source).toBe('agent_conversation');
    expect(events.rows[0]?.source_id).toBe('cli:session:shirtless-1');
    expect(events.rows[0]?.occurred_at).toEqual(new Date('2026-04-14T10:12:00.000Z'));
    expect(events.rows[0]?.author).toBe('shirtless');
    expect(events.rows[0]?.url_or_locator).toBe('cli:session:shirtless-1');
    expect(events.rows[0]?.title).toBe('Ship the Innies adapter.');
    expect(events.rows[0]?.summary).toBe('Add message artifacts too. | Confirmed the adapter is emitting artifacts.');
    expect(events.rows[0]?.raw_text).toBe([
      'user: Ship the Innies adapter.',
      'assistant: Implemented the first draft.',
      'user: Add message artifacts too.',
      'assistant: Confirmed the adapter is emitting artifacts.',
    ].join('\n\n'));
    expect(events.rows[0]?.artifact_refs).toEqual([
      { artifactType: 'message_excerpt', artifactKey: '10000000-0000-4000-8000-000000000001:request:0' },
      { artifactType: 'message_excerpt', artifactKey: '10000000-0000-4000-8000-000000000001:response:0' },
      { artifactType: 'message_excerpt', artifactKey: '10000000-0000-4000-8000-000000000002:request:0' },
      { artifactType: 'message_excerpt', artifactKey: '10000000-0000-4000-8000-000000000002:response:0' },
      { artifactType: 'session_metadata', artifactKey: 'cli:session:shirtless-1' },
    ]);
    expect(events.rows[0]?.raw_payload).toEqual({
      sessionKey: 'cli:session:shirtless-1',
      messageCount: 4,
      providerSet: ['anthropic', 'openai'],
      modelSet: ['claude-opus-4.5', 'gpt-5.4'],
    });
    expect(artifacts.rows).toEqual([
      {
        artifact_type: 'message_excerpt',
        artifact_key: '10000000-0000-4000-8000-000000000001:request:0',
        content_text: 'Ship the Innies adapter.',
        content_json: {
          attemptNo: 1,
          model: 'gpt-5.4',
          ordinal: 0,
          provider: 'openai',
          requestAttemptArchiveId: '10000000-0000-4000-8000-000000000001',
          requestId: 'req-shirtless-1',
          role: 'user',
          side: 'request',
          usedRawFallback: false,
        },
      },
      {
        artifact_type: 'message_excerpt',
        artifact_key: '10000000-0000-4000-8000-000000000001:response:0',
        content_text: 'Implemented the first draft.',
        content_json: {
          attemptNo: 1,
          model: 'gpt-5.4',
          ordinal: 0,
          provider: 'openai',
          requestAttemptArchiveId: '10000000-0000-4000-8000-000000000001',
          requestId: 'req-shirtless-1',
          role: 'assistant',
          side: 'response',
          usedRawFallback: false,
        },
      },
      {
        artifact_type: 'message_excerpt',
        artifact_key: '10000000-0000-4000-8000-000000000002:request:0',
        content_text: 'Add message artifacts too.',
        content_json: {
          attemptNo: 1,
          model: 'claude-opus-4.5',
          ordinal: 0,
          provider: 'anthropic',
          requestAttemptArchiveId: '10000000-0000-4000-8000-000000000002',
          requestId: 'req-shirtless-2',
          role: 'user',
          side: 'request',
          usedRawFallback: false,
        },
      },
      {
        artifact_type: 'message_excerpt',
        artifact_key: '10000000-0000-4000-8000-000000000002:response:0',
        content_text: 'Confirmed the adapter is emitting artifacts.',
        content_json: {
          attemptNo: 1,
          model: 'claude-opus-4.5',
          ordinal: 0,
          provider: 'anthropic',
          requestAttemptArchiveId: '10000000-0000-4000-8000-000000000002',
          requestId: 'req-shirtless-2',
          role: 'assistant',
          side: 'response',
          usedRawFallback: false,
        },
      },
      {
        artifact_type: 'session_metadata',
        artifact_key: 'cli:session:shirtless-1',
        content_text: null,
        content_json: {
          attemptCount: 2,
          buyerKeyName: 'shirtless',
          endedAt: '2026-04-14T10:12:00.000Z',
          lastActivityAt: '2026-04-14T10:12:00.000Z',
          modelSet: ['claude-opus-4.5', 'gpt-5.4'],
          providerSet: ['anthropic', 'openai'],
          requestCount: 2,
          sessionKey: 'cli:session:shirtless-1',
          sessionType: 'cli',
          startedAt: '2026-04-14T10:00:00.000Z',
        },
      },
    ]);
  });

  it('prefers normalized payload text and only falls back to raw blobs when normalized text is empty', async () => {
    await database.pool.query(
      `
        insert into in_api_keys (id, name)
        values ($1, $2)
      `,
      [
        '00000000-0000-4000-8000-000000000001',
        'shirtless',
      ],
    );
    await database.pool.query(
      `
        insert into in_admin_sessions (
          session_key,
          api_key_id,
          session_type,
          started_at,
          ended_at,
          last_activity_at,
          request_count,
          attempt_count
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        'cli:session:shirtless-fallback',
        '00000000-0000-4000-8000-000000000001',
        'cli',
        new Date('2026-04-14T12:00:00.000Z'),
        new Date('2026-04-14T12:10:00.000Z'),
        new Date('2026-04-14T12:10:00.000Z'),
        2,
        2,
      ],
    );
    await database.pool.query(
      `
        insert into in_admin_session_attempts (
          session_key,
          request_attempt_archive_id,
          request_id,
          attempt_no,
          event_time,
          sequence_no,
          provider,
          model,
          status
        )
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9),
          ($10, $11, $12, $13, $14, $15, $16, $17, $18)
      `,
      [
        'cli:session:shirtless-fallback',
        '30000000-0000-4000-8000-000000000001',
        'req-primary',
        1,
        new Date('2026-04-14T12:01:00.000Z'),
        0,
        'openai',
        'gpt-5.4',
        'success',
        'cli:session:shirtless-fallback',
        '30000000-0000-4000-8000-000000000002',
        'req-fallback',
        1,
        new Date('2026-04-14T12:08:00.000Z'),
        1,
        'openai',
        'gpt-5.4',
        'success',
      ],
    );
    await database.pool.query(
      `
        insert into in_message_blobs (id, normalized_payload)
        values
          ($1, $2::jsonb),
          ($3, $4::jsonb),
          ($5, $6::jsonb),
          ($7, $8::jsonb)
      `,
      [
        '40000000-0000-4000-8000-000000000001',
        message('user', 'Keep normalized content first.'),
        '40000000-0000-4000-8000-000000000002',
        message('assistant', 'Normalized answer wins.'),
        '40000000-0000-4000-8000-000000000003',
        message('user', 'Fallback if the assistant payload is empty.'),
        '40000000-0000-4000-8000-000000000004',
        emptyAssistantMessage(),
      ],
    );
    await database.pool.query(
      `
        insert into in_request_attempt_messages (
          request_attempt_archive_id,
          side,
          ordinal,
          message_blob_id,
          role,
          content_type
        )
        values
          ($1, 'request', 0, $2, 'user', 'text'),
          ($1, 'response', 0, $3, 'assistant', 'text'),
          ($4, 'request', 0, $5, 'user', 'text'),
          ($4, 'response', 0, $6, 'assistant', 'text')
      `,
      [
        '30000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000002',
        '30000000-0000-4000-8000-000000000002',
        '40000000-0000-4000-8000-000000000003',
        '40000000-0000-4000-8000-000000000004',
      ],
    );
    await database.pool.query(
      `
        insert into in_raw_blobs (id, encoding, payload)
        values
          ($1, 'none', $2::bytea),
          ($3, 'gzip', $4::bytea)
      `,
      [
        '50000000-0000-4000-8000-000000000001',
        Buffer.from('RAW SHOULD NOT WIN', 'utf8'),
        '50000000-0000-4000-8000-000000000002',
        gzipSync(Buffer.from('data: {"output_text":"Raw fallback answer."}\n\ndata: [DONE]\n', 'utf8')),
      ],
    );
    await database.pool.query(
      `
        insert into in_request_attempt_raw_blobs (request_attempt_archive_id, blob_role, raw_blob_id)
        values
          ($1, 'response', $2),
          ($3, 'response', $4)
      `,
      [
        '30000000-0000-4000-8000-000000000001',
        '50000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000002',
        '50000000-0000-4000-8000-000000000002',
      ],
    );

    const source = createInniesSource(database.pool, {
      buyerKeyName: 'shirtless',
    });

    await source.sync();

    const event = await database.pool.query<{ raw_text: string }>('select raw_text from sp_events limit 1');
    const artifacts = await database.pool.query<{
      artifact_key: string;
      content_text: string | null;
      content_json: { usedRawFallback: boolean };
    }>(
      `
        select artifact_key, content_text, content_json
        from sp_artifacts
        where artifact_type = 'message_excerpt'
        order by artifact_key
      `,
    );

    expect(event.rows[0]?.raw_text).toContain('assistant: Normalized answer wins.');
    expect(event.rows[0]?.raw_text).toContain('assistant: Raw fallback answer.');
    expect(event.rows[0]?.raw_text).not.toContain('RAW SHOULD NOT WIN');
    expect(artifacts.rows).toHaveLength(4);
    expect(artifacts.rows).toMatchObject([
      {
        artifact_key: '30000000-0000-4000-8000-000000000001:request:0',
        content_text: 'Keep normalized content first.',
        content_json: { usedRawFallback: false },
      },
      {
        artifact_key: '30000000-0000-4000-8000-000000000001:response:0',
        content_text: 'Normalized answer wins.',
        content_json: { usedRawFallback: false },
      },
      {
        artifact_key: '30000000-0000-4000-8000-000000000002:request:0',
        content_text: 'Fallback if the assistant payload is empty.',
        content_json: { usedRawFallback: false },
      },
      {
        artifact_key: '30000000-0000-4000-8000-000000000002:response:0',
        content_text: 'Raw fallback answer.',
        content_json: { usedRawFallback: true },
      },
    ]);
  });

  it('limits imported sessions to the configured rolling lookback window', async () => {
    const now = Date.now();
    const oldStartedAt = new Date(now - 30 * 60 * 60 * 1000);
    const oldEndedAt = new Date(now - 29 * 60 * 60 * 1000);
    const oldLastActivityAt = new Date(now - 29 * 60 * 60 * 1000);
    const oldEventTime = new Date(now - 29.5 * 60 * 60 * 1000);
    const recentStartedAt = new Date(now - 2 * 60 * 60 * 1000);
    const recentEndedAt = new Date(now - 90 * 60 * 1000);
    const recentLastActivityAt = new Date(now - 90 * 60 * 1000);
    const recentEventTime = new Date(now - 100 * 60 * 1000);

    await database.pool.query(
      `
        insert into in_api_keys (id, name)
        values ($1, $2)
      `,
      ['60000000-0000-4000-8000-000000000001', 'shirtless'],
    );
    await database.pool.query(
      `
        insert into in_admin_sessions (
          session_key,
          api_key_id,
          session_type,
          started_at,
          ended_at,
          last_activity_at,
          request_count,
          attempt_count
        )
        values
          ($1, $2, 'cli', $3, $4, $5, 1, 1),
          ($6, $2, 'cli', $7, $8, $9, 1, 1)
      `,
      [
        'cli:session:old',
        '60000000-0000-4000-8000-000000000001',
        oldStartedAt,
        oldEndedAt,
        oldLastActivityAt,
        'cli:session:recent',
        recentStartedAt,
        recentEndedAt,
        recentLastActivityAt,
      ],
    );
    await database.pool.query(
      `
        insert into in_admin_session_attempts (
          session_key,
          request_attempt_archive_id,
          request_id,
          attempt_no,
          event_time,
          sequence_no,
          provider,
          model,
          status
        )
        values
          ($1, $2, $3, 1, $4, 1, 'openai', 'gpt-5.4', 'completed'),
          ($5, $6, $7, 1, $8, 1, 'openai', 'gpt-5.4', 'completed')
      `,
      [
        'cli:session:old',
        '70000000-0000-4000-8000-000000000001',
        'old-request',
        oldEventTime,
        'cli:session:recent',
        '70000000-0000-4000-8000-000000000002',
        'recent-request',
        recentEventTime,
      ],
    );
    await database.pool.query(
      `
        insert into in_message_blobs (id, normalized_payload)
        values
          ($1, $2::jsonb),
          ($3, $4::jsonb),
          ($5, $6::jsonb),
          ($7, $8::jsonb)
      `,
      [
        '80000000-0000-4000-8000-000000000001',
        message('user', 'This old session should not be imported.'),
        '80000000-0000-4000-8000-000000000002',
        message('assistant', 'Old response.'),
        '80000000-0000-4000-8000-000000000003',
        message('user', 'This recent session should be imported.'),
        '80000000-0000-4000-8000-000000000004',
        message('assistant', 'Recent response.'),
      ],
    );
    await database.pool.query(
      `
        insert into in_request_attempt_messages (
          request_attempt_archive_id,
          side,
          ordinal,
          message_blob_id,
          role,
          content_type
        )
        values
          ($1, 'request', 0, $2, 'user', 'text'),
          ($1, 'response', 0, $3, 'assistant', 'text'),
          ($4, 'request', 0, $5, 'user', 'text'),
          ($4, 'response', 0, $6, 'assistant', 'text')
      `,
      [
        '70000000-0000-4000-8000-000000000001',
        '80000000-0000-4000-8000-000000000001',
        '80000000-0000-4000-8000-000000000002',
        '70000000-0000-4000-8000-000000000002',
        '80000000-0000-4000-8000-000000000003',
        '80000000-0000-4000-8000-000000000004',
      ],
    );

    const source = createInniesSource(database.pool, {
      buyerKeyName: 'shirtless',
      lookbackHours: 12,
    });

    await source.sync();

    const events = await database.pool.query<{ source_id: string }>(
      `
        select source_id
        from sp_events
        order by source_id
      `,
    );

    expect(events.rows).toEqual([{ source_id: 'cli:session:recent' }]);
  });
});
