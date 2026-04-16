import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/db/migrate';
import { createPool } from '../../../src/db/pool';
import { createCandidatesRepository } from '../../../src/db/repositories/candidates-repository';
import { upsertEvents } from '../../../src/normalization/upsert-events';
import { publishCandidate } from '../../../src/publisher/publish-candidate';
import type { NormalizedEventInput } from '../../../src/normalization/types';
import type { TelegramClient } from '../../../src/telegram/client';

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
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'auto-biographer-publisher-'));
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

async function seedEvents(pool: Pool, events: readonly NormalizedEventInput[]) {
  return upsertEvents(pool, events);
}

function createStubTelegramClient() {
  const sentMessages: string[] = [];

  const client: TelegramClient = {
    async getUpdates() {
      return [];
    },
    async sendMessage(input) {
      sentMessages.push(input.text);

      return {
        message_id: sentMessages.length + 8000,
        chat: { id: -1001234567890, type: 'private' },
        text: input.text,
      };
    },
    async sendCandidatePackage(candidatePackage) {
      return {
        message_id: 8000,
        chat: { id: -1001234567890, type: 'private' },
        text: candidatePackage.draftText,
      };
    },
    async getFile() {
      return {
        fileId: 'ignored',
        filePath: 'ignored.jpg',
        downloadUrl: 'https://example.com/ignored.jpg',
      };
    },
  };

  return { client, sentMessages };
}

describe('publishCandidate', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    await resetSchema(database.pool);
    await runMigrations(database.pool);
  });

  afterAll(async () => {
    if (database) {
      await stopTestDatabase(database);
    }
  });

  it('publishes a post_requested candidate and records source usage', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const telegram = createStubTelegramClient();
    const seeded = await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-publish-success',
        occurredAt: new Date('2026-04-15T10:10:00.000Z'),
        author: 'dylanvu',
        summary: 'Fresh GitHub activity for publish success',
        artifacts: [
          {
            artifactType: 'commit',
            artifactKey: 'abc123',
            contentText: 'feat: add publisher',
          },
        ],
      },
    ]);
    const event = seeded[0];

    if (!event) {
      throw new Error('Expected seeded event');
    }

    const artifact = event.artifacts[0];

    if (!artifact) {
      throw new Error('Expected seeded artifact');
    }

    const candidate = await candidatesRepository.createCandidate({
      triggerType: 'manual',
      candidateType: 'ship_update',
      status: 'post_requested',
      finalPostText: 'Shipped the publisher path.',
      quoteTargetUrl: 'https://x.com/example/status/123',
    });

    await database.pool.query(
      `
        insert into sp_candidate_sources (candidate_id, event_id, artifact_id)
        values ($1, $2, null), ($1, $2, $3)
      `,
      [candidate.id, event.event.id, artifact.id],
    );

    await publishCandidate({
      db: database.pool,
      telegramClient: telegram.client,
      candidateId: candidate.id,
      postProfile: 'bicep_pump',
      clawdTweetScript: '/srv/clawd/scripts/tweet.js',
      now: () => new Date('2026-04-15T14:35:00.000Z'),
      publishToX: vi.fn(async () => ({
        tweetId: '1900000000000000001',
        url: 'https://x.com/bicep_pump/status/1900000000000000001',
        raw: { ok: true, tweetId: '1900000000000000001' },
      })),
    });

    const candidateRow = await database.pool.query<{ status: string; error_details: string | null }>(
      `
        select status, error_details
        from sp_post_candidates
        where id = $1
      `,
      [candidate.id],
    );
    const publishedPosts = await database.pool.query<{
      candidate_id: string;
      x_post_id: string | null;
      post_type: string;
      media_attached: boolean;
    }>(`
      select candidate_id, x_post_id, post_type, media_attached
      from sp_published_posts
    `);
    const sourceUsage = await database.pool.query<{ event_id: string; artifact_id: string | null }>(`
      select event_id, artifact_id
      from sp_source_usage
      order by artifact_id nulls first
    `);

    expect(candidateRow.rows).toEqual([{ status: 'published', error_details: null }]);
    expect(publishedPosts.rows).toEqual([
      {
        candidate_id: candidate.id,
        x_post_id: '1900000000000000001',
        post_type: 'quote_tweet',
        media_attached: false,
      },
    ]);
    expect(sourceUsage.rows).toEqual([
      { event_id: event.event.id, artifact_id: null },
      { event_id: event.event.id, artifact_id: artifact.id },
    ]);
    expect(telegram.sentMessages).toEqual([]);
  });

  it('fails delivery and notifies telegram when a stored photo batch exceeds the v1 limit', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const telegram = createStubTelegramClient();
    const candidate = await candidatesRepository.createCandidate({
      triggerType: 'manual',
      candidateType: 'ship_update',
      status: 'post_requested',
      finalPostText: 'Too many photos should fail.',
      telegramMessageId: '8000',
      mediaBatchJson: {
        kind: 'telegram_photo_batch',
        replyMessageId: 8000,
        mediaGroupId: 'album-1',
        capturedAt: '2026-04-15T14:40:00.000Z',
        photos: [1, 2, 3, 4, 5].map((index) => ({
          fileId: `file-${String(index)}`,
          fileUniqueId: `uniq-${String(index)}`,
          width: 1280,
          height: 720,
        })),
      },
    });

    await publishCandidate({
      db: database.pool,
      telegramClient: telegram.client,
      candidateId: candidate.id,
      postProfile: 'bicep_pump',
      clawdTweetScript: '/srv/clawd/scripts/tweet.js',
      publishToX: vi.fn(),
    });

    const candidateRow = await database.pool.query<{ status: string; error_details: string | null }>(
      `
        select status, error_details
        from sp_post_candidates
        where id = $1
      `,
      [candidate.id],
    );
    const publishedPostCount = await database.pool.query<{ count: string }>(
      'select count(*) from sp_published_posts',
    );

    expect(candidateRow.rows).toEqual([
      {
        status: 'delivery_failed',
        error_details: 'Telegram photo batches must contain between 1 and 4 photos',
      },
    ]);
    expect(publishedPostCount.rows[0]?.count).toBe('0');
    expect(telegram.sentMessages).toEqual([
      `X publish failed for candidate #${candidate.id}: Telegram photo batches must contain between 1 and 4 photos`,
    ]);
  });

  it('publishes repo-backed original posts as a thread with a repo-link reply', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const telegram = createStubTelegramClient();
    const seeded = await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-thread-publish',
        occurredAt: new Date('2026-04-15T15:10:00.000Z'),
        author: 'dylanvu',
        title: 'auto-biographer push',
        summary: 'Shipped the thread-aware drafter',
        urlOrLocator: 'https://github.com/dylanvu/auto-biographer/commit/abc123',
        tags: ['repo:dylanvu/auto-biographer', 'action:push'],
        rawPayload: {
          repo: 'dylanvu/auto-biographer',
        },
      },
    ]);
    const event = seeded[0];

    if (!event) {
      throw new Error('Expected seeded event');
    }

    const candidate = await candidatesRepository.createCandidate({
      triggerType: 'manual',
      candidateType: 'ship_update',
      status: 'post_requested',
      finalPostText: 'Lead tweet for the shipped project.',
      drafterOutputJson: {
        decision: 'success',
        delivery_kind: 'single_post',
        draft_text: 'Lead tweet for the shipped project.',
        candidate_type: 'ship_update',
        quote_target_url: null,
        why_chosen: 'Repo-backed original post.',
        receipts: ['repo selected'],
        media_request: 'annotated repo screenshot',
        allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
      },
    });

    await database.pool.query(
      `
        insert into sp_candidate_sources (candidate_id, event_id, artifact_id)
        values ($1, $2, null)
      `,
      [candidate.id, event.event.id],
    );

    const publishToX = vi
      .fn()
      .mockResolvedValueOnce({
        tweetId: '1900000000000000010',
        url: 'https://x.com/bicep_pump/status/1900000000000000010',
        raw: { ok: true, tweetId: '1900000000000000010' },
      })
      .mockResolvedValueOnce({
        tweetId: '1900000000000000011',
        url: 'https://x.com/bicep_pump/status/1900000000000000011',
        raw: { ok: true, tweetId: '1900000000000000011' },
      });

    await publishCandidate({
      db: database.pool,
      telegramClient: telegram.client,
      candidateId: candidate.id,
      postProfile: 'bicep_pump',
      clawdTweetScript: '/srv/clawd/scripts/tweet.js',
      now: () => new Date('2026-04-15T15:35:00.000Z'),
      publishToX,
      resolvePublicRepoLinkUrl: vi.fn(async ({ repoUrl }) => repoUrl),
    });

    expect(publishToX).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        text: 'Lead tweet for the shipped project.',
        quoteTargetUrl: null,
      }),
    );
    expect(publishToX).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        text: 'https://github.com/dylanvu/auto-biographer',
        replyToTweetId: '1900000000000000010',
      }),
    );

    const publishedPosts = await database.pool.query<{
      candidate_id: string;
      x_post_id: string | null;
      post_type: string;
    }>(`
      select candidate_id, x_post_id, post_type
      from sp_published_posts
    `);

    expect(publishedPosts.rows).toEqual([
      {
        candidate_id: candidate.id,
        x_post_id: '1900000000000000010',
        post_type: 'thread',
      },
    ]);
  });

  it('publishes repo-backed originals as a single post when the repo is private', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const telegram = createStubTelegramClient();
    const seeded = await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-private-thread-publish',
        occurredAt: new Date('2026-04-15T15:20:00.000Z'),
        author: 'dylanvu',
        title: 'secret-project push',
        summary: 'Shipped the private project',
        urlOrLocator: 'https://github.com/dylanvu/secret-project/commit/abc123',
        tags: ['repo:dylanvu/secret-project', 'action:push'],
        rawPayload: {
          repo: 'dylanvu/secret-project',
        },
      },
    ]);
    const event = seeded[0];

    if (!event) {
      throw new Error('Expected seeded event');
    }

    const candidate = await candidatesRepository.createCandidate({
      triggerType: 'manual',
      candidateType: 'ship_update',
      status: 'post_requested',
      finalPostText: 'Lead tweet for the private project.',
      drafterOutputJson: {
        decision: 'success',
        delivery_kind: 'single_post',
        draft_text: 'Lead tweet for the private project.',
        candidate_type: 'ship_update',
        quote_target_url: null,
        why_chosen: 'Repo-backed original post.',
        receipts: ['private repo selected'],
        media_request: 'annotated repo screenshot',
        allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
      },
    });

    await database.pool.query(
      `
        insert into sp_candidate_sources (candidate_id, event_id, artifact_id)
        values ($1, $2, null)
      `,
      [candidate.id, event.event.id],
    );

    const publishToX = vi.fn().mockResolvedValue({
      tweetId: '1900000000000000020',
      url: 'https://x.com/bicep_pump/status/1900000000000000020',
      raw: { ok: true, tweetId: '1900000000000000020' },
    });

    await publishCandidate({
      db: database.pool,
      telegramClient: telegram.client,
      candidateId: candidate.id,
      postProfile: 'bicep_pump',
      clawdTweetScript: '/srv/clawd/scripts/tweet.js',
      now: () => new Date('2026-04-15T15:45:00.000Z'),
      publishToX,
      resolvePublicRepoLinkUrl: vi.fn(async () => null),
    });

    expect(publishToX).toHaveBeenCalledTimes(1);
    expect(publishToX).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Lead tweet for the private project.',
        quoteTargetUrl: null,
      }),
    );

    const publishedPosts = await database.pool.query<{
      candidate_id: string;
      x_post_id: string | null;
      post_type: string;
    }>(`
      select candidate_id, x_post_id, post_type
      from sp_published_posts
    `);

    expect(publishedPosts.rows).toEqual([
      {
        candidate_id: candidate.id,
        x_post_id: '1900000000000000020',
        post_type: 'tweet',
      },
    ]);
  });
});
