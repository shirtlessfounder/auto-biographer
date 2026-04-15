import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/db/migrate';
import { createPool } from '../../../src/db/pool';
import { createSlackMessagesSource } from '../../../src/sources/slack-messages-source';

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
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'auto-biographer-slack-messages-'));
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
    `-h 127.0.0.1 -p ${String(port)}`,
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

async function createSlackMessagesTable(pool: Pool): Promise<void> {
  await pool.query(`
    create table slack_messages (
      id bigserial primary key,
      channel_id text not null,
      channel_name text,
      message_ts text not null,
      user_id text,
      user_name text,
      text text not null,
      thread_ts text,
      posted_at timestamptz not null,
      synced_at timestamptz not null
    )
  `);
}

describe('createSlackMessagesSource', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    await resetSchema(database.pool);
    await runMigrations(database.pool);
    await createSlackMessagesTable(database.pool);
  });

  afterAll(async () => {
    if (database) {
      await stopTestDatabase(database);
    }
  });

  it('filters Dylan-authored rows and upserts slack_message events', async () => {
    await database.pool.query(
      `
        insert into slack_messages (
          channel_id,
          channel_name,
          message_ts,
          user_id,
          user_name,
          text,
          thread_ts,
          posted_at,
          synced_at
        )
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9),
          ($10, $11, $12, $13, $14, $15, $16, $17, $18),
          ($19, $20, $21, $22, $23, $24, $25, $26, $27)
      `,
      [
        'C123',
        'shiproom',
        '1713175200.000100',
        'U00000',
        'Dylan Vu',
        'Shipped the auto-biographer foundation.',
        null,
        new Date('2026-04-15T10:00:00.000Z'),
        new Date('2026-04-15T10:05:00.000Z'),
        'C123',
        'shiproom',
        '1713178800.000200',
        'U12345',
        null,
        'Matched by user id even without a display name.',
        null,
        new Date('2026-04-15T11:00:00.000Z'),
        new Date('2026-04-15T11:05:00.000Z'),
        'C999',
        'random',
        '1713182400.000300',
        'U99999',
        'Someone Else',
        'Ignore this row.',
        null,
        new Date('2026-04-15T12:00:00.000Z'),
        new Date('2026-04-15T12:05:00.000Z'),
      ],
    );

    const source = createSlackMessagesSource(database.pool, {
      authorNames: ['Dylan Vu', 'dylan'],
      authorUserIds: ['U12345'],
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
      tags: unknown;
      artifact_refs: unknown;
      raw_payload: unknown;
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
          tags,
          artifact_refs,
          raw_payload
        from sp_events
        order by source_id
      `,
    );

    expect(persisted).toHaveLength(2);
    expect(events.rows).toEqual([
      {
        source: 'slack_message',
        source_id: '1',
        occurred_at: new Date('2026-04-15T10:00:00.000Z'),
        author: 'Dylan Vu',
        url_or_locator: null,
        title: null,
        summary: null,
        raw_text: 'Shipped the auto-biographer foundation.',
        tags: ['shiproom'],
        artifact_refs: [],
        raw_payload: null,
      },
      {
        source: 'slack_message',
        source_id: '2',
        occurred_at: new Date('2026-04-15T11:00:00.000Z'),
        author: 'U12345',
        url_or_locator: null,
        title: null,
        summary: null,
        raw_text: 'Matched by user id even without a display name.',
        tags: ['shiproom'],
        artifact_refs: [],
        raw_payload: null,
      },
    ]);
  });

  it('limits imported slack messages to the configured rolling lookback window', async () => {
    const now = Date.now();

    await database.pool.query(
      `
        insert into slack_messages (
          channel_id,
          channel_name,
          message_ts,
          user_id,
          user_name,
          text,
          thread_ts,
          posted_at,
          synced_at
        )
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9),
          ($10, $11, $12, $13, $14, $15, $16, $17, $18)
      `,
      [
        'C123',
        'shiproom',
        '1713067200.000100',
        'U12345',
        'Dylan Vu',
        'Old message should not be imported.',
        null,
        new Date(now - 30 * 60 * 60 * 1000),
        new Date(now - 30 * 60 * 60 * 1000),
        'C123',
        'shiproom',
        '1713175200.000100',
        'U12345',
        'Dylan Vu',
        'Recent message should be imported.',
        null,
        new Date(now - 2 * 60 * 60 * 1000),
        new Date(now - 2 * 60 * 60 * 1000),
      ],
    );

    const source = createSlackMessagesSource(database.pool, {
      authorNames: ['Dylan Vu'],
      authorUserIds: ['U12345'],
      lookbackHours: 12,
    });

    await source.sync();

    const events = await database.pool.query<{ source_id: string; raw_text: string | null }>(
      `
        select source_id, raw_text
        from sp_events
        order by source_id
      `,
    );

    expect(events.rows).toEqual([
      {
        source_id: '2',
        raw_text: 'Recent message should be imported.',
      },
    ]);
  });
});
