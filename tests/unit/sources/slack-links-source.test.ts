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
import { createSlackLinksSource } from '../../../src/sources/slack-links-source';

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
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'social-posting-slack-links-'));
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

async function createSlackLinksTable(pool: Pool): Promise<void> {
  await pool.query(`
    create table sl_links (
      id bigserial primary key,
      url text not null,
      canonical_url text not null,
      final_url text,
      domain text not null,
      raw_payload jsonb,
      first_seen_at timestamptz not null,
      captured_at timestamptz,
      slack_channel_name text,
      slack_user_id text,
      slack_message_ts text not null,
      slack_permalink text
    )
  `);
}

describe('createSlackLinksSource', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    await resetSchema(database.pool);
    await runMigrations(database.pool);
    await createSlackLinksTable(database.pool);
  });

  afterAll(async () => {
    if (database) {
      await stopTestDatabase(database);
    }
  });

  it('filters Dylan-authored rows from the live schema and preserves raw captures as artifacts', async () => {
    await database.pool.query(
      `
        insert into sl_links (
          url,
          canonical_url,
          final_url,
          domain,
          raw_payload,
          first_seen_at,
          captured_at,
          slack_channel_name,
          slack_user_id,
          slack_message_ts,
          slack_permalink
        )
        values
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11),
          ($12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      `,
      [
        'https://example.com/post',
        'https://example.com/post',
        'https://example.com/post?ref=slack',
        'example.com',
        JSON.stringify({ source: 'capture-v1' }),
        new Date('2026-04-15T12:00:00.000Z'),
        new Date('2026-04-15T12:01:00.000Z'),
        'shiproom',
        'U12345',
        '1713182400.000300',
        'https://slack.com/archives/C123/p1713182400000300',
        'https://example.com/not-dylan',
        'https://example.com/not-dylan',
        'https://example.com/not-dylan',
        'example.com',
        JSON.stringify({ source: 'capture-v1' }),
        new Date('2026-04-15T13:00:00.000Z'),
        new Date('2026-04-15T13:01:00.000Z'),
        'random',
        'U99999',
        '1713186000.000400',
        'https://slack.com/archives/C123/p1713186000000400',
      ],
    );

    const source = createSlackLinksSource(database.pool, {
      authorNames: ['Dylan Vu', 'dylan'],
      authorUserIds: ['U12345'],
    });

    const firstPass = await source.sync();

    await database.pool.query(
      `
        update sl_links
        set raw_payload = $2
        where id = $1
      `,
      [1, JSON.stringify({ source: 'capture-v2' })],
    );

    const secondPass = await source.sync();
    const events = await database.pool.query<{
      source: string;
      source_id: string;
      occurred_at: Date;
      author: string | null;
      url_or_locator: string | null;
      title: string | null;
      raw_text: string | null;
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
          raw_text,
          artifact_refs,
          raw_payload
        from sp_events
      `,
    );
    const artifacts = await database.pool.query<{
      artifact_type: string;
      artifact_key: string;
      content_text: string | null;
      content_json: unknown;
      source_url: string | null;
    }>(
      `
        select artifact_type, artifact_key, content_text, content_json, source_url
        from sp_artifacts
        order by artifact_key
      `,
    );

    expect(firstPass).toHaveLength(1);
    expect(secondPass).toHaveLength(1);
    expect(events.rows).toEqual([
      {
        source: 'slack_link',
        source_id: '1',
        occurred_at: new Date('2026-04-15T12:00:00.000Z'),
        author: 'U12345',
        url_or_locator: 'https://example.com/post',
        title: null,
        raw_text: null,
        artifact_refs: [
          { artifactType: 'json', artifactKey: 'captured_raw_payload' },
        ],
        raw_payload: {
          canonicalUrl: 'https://example.com/post',
          domain: 'example.com',
          finalUrl: 'https://example.com/post?ref=slack',
          slackPermalink: 'https://slack.com/archives/C123/p1713182400000300',
          sourceUrl: 'https://example.com/post',
        },
      },
    ]);
    expect(artifacts.rows).toEqual([
      {
        artifact_type: 'json',
        artifact_key: 'captured_raw_payload',
        content_text: null,
        content_json: { source: 'capture-v2' },
        source_url: 'https://example.com/post',
      },
    ]);
  });
});
