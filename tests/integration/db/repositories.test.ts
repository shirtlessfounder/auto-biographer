import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/db/migrate';
import { createPool } from '../../../src/db/pool';
import { createCandidatesRepository } from '../../../src/db/repositories/candidates-repository';
import { createEventsRepository } from '../../../src/db/repositories/events-repository';
import { createPublishedPostsRepository } from '../../../src/db/repositories/published-posts-repository';
import { createRuntimeStateRepository } from '../../../src/db/repositories/runtime-state-repository';
import { createTelegramActionsRepository } from '../../../src/db/repositories/telegram-actions-repository';
import { createCandidateControlMessagesRepository } from '../../../src/db/repositories/candidate-control-messages-repository';

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
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'auto-biographer-repositories-'));
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

describe('database repositories', () => {
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

  it('upserts events by source and source id', async () => {
    const eventsRepository = createEventsRepository(database.pool);

    const inserted = await eventsRepository.upsertEvent({
      source: 'github',
      sourceId: 'evt-1',
      occurredAt: new Date('2026-04-05T12:00:00.000Z'),
      author: 'dylanvu',
      urlOrLocator: 'https://github.com/dylanvu/auto-biographer/commit/abc123',
      title: 'Initial title',
      summary: 'Initial summary',
      rawText: 'Initial raw text',
      tags: ['github', 'commit'],
      artifactRefs: [{ type: 'commit' }],
      rawPayload: { id: 1 },
    });
    const updated = await eventsRepository.upsertEvent({
      source: 'github',
      sourceId: 'evt-1',
      occurredAt: new Date('2026-04-05T12:05:00.000Z'),
      author: 'dylanvu',
      urlOrLocator: 'https://github.com/dylanvu/auto-biographer/commit/def456',
      title: 'Updated title',
      summary: 'Updated summary',
      rawText: 'Updated raw text',
      tags: ['github', 'release'],
      artifactRefs: [{ type: 'release' }],
      rawPayload: { id: 2 },
    });
    const countResult = await database.pool.query<{ count: string }>('select count(*) from sp_events');

    expect(inserted.id).toBe(updated.id);
    expect(updated.title).toBe('Updated title');
    expect(updated.summary).toBe('Updated summary');
    expect(updated.tags).toEqual(['github', 'release']);
    expect(updated.rawPayload).toEqual({ id: 2 });
    expect(countResult.rows[0]?.count).toBe('1');
  });

  it('creates candidates, tracks multiple control messages, and replaces media by any mapped telegram message id', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const controlMessagesRepository = createCandidateControlMessagesRepository(database.pool);
    const firstMediaBatch = {
      kind: 'telegram_photo_batch',
      replyMessageId: 9001,
      mediaGroupId: null,
      capturedAt: '2026-04-14T21:30:00.000Z',
      photos: [{ fileId: 'file-1', fileUniqueId: 'uniq-1', width: 1280, height: 720 }],
    };
    const nextMediaBatch = {
      kind: 'telegram_photo_batch',
      replyMessageId: 9002,
      mediaGroupId: 'album-1',
      capturedAt: '2026-04-14T21:45:00.000Z',
      photos: [
        { fileId: 'file-2', fileUniqueId: 'uniq-2', width: 1440, height: 900 },
        { fileId: 'file-3', fileUniqueId: 'uniq-3', width: 1600, height: 1200 },
      ],
    };

    const created = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'event_summary',
      status: 'drafting',
      deadlineAt: new Date('2026-04-05T12:15:00.000Z'),
      selectorOutputJson: { sourceEventIds: ['1'] },
    });
    const updated = await candidatesRepository.updateCandidate(created.id, {
      drafterOutputJson: { draft: 'hello world' },
      finalPostText: 'hello world',
      quoteTargetUrl: 'https://x.com/example/status/1',
      mediaRequest: 'none',
      telegramMessageId: '9001',
      mediaBatchJson: firstMediaBatch,
      degraded: true,
    });
    const transitioned = await candidatesRepository.transitionStatus({
      id: created.id,
      fromStatuses: ['drafting'],
      toStatus: 'pending_approval',
      reminderSentAt: new Date('2026-04-05T12:10:00.000Z'),
    });

    await controlMessagesRepository.recordControlMessage({
      candidateId: created.id,
      telegramMessageId: '9001',
      messageKind: 'draft',
    });
    await controlMessagesRepository.recordControlMessage({
      candidateId: created.id,
      telegramMessageId: '9002',
      messageKind: 'reminder',
    });

    const rejectedTransition = await candidatesRepository.transitionStatus({
      id: created.id,
      fromStatuses: ['drafting'],
      toStatus: 'published',
    });
    const replacedByOriginal = await candidatesRepository.replaceMediaBatchByTelegramMessageId({
      telegramMessageId: '9001',
      allowedStatuses: ['pending_approval', 'reminded', 'held'],
      mediaBatchJson: nextMediaBatch,
    });
    const resolvedReminder = await controlMessagesRepository.findCandidateByTelegramMessageId({
      telegramMessageId: '9002',
      allowedStatuses: ['pending_approval', 'reminded', 'held'],
    });
    const controlMessages = await controlMessagesRepository.listControlMessages(created.id);

    expect(updated.finalPostText).toBe('hello world');
    expect(updated.quoteTargetUrl).toBe('https://x.com/example/status/1');
    expect(updated.telegramMessageId).toBe('9001');
    expect(updated.mediaBatchJson).toEqual(firstMediaBatch);
    expect(updated.degraded).toBe(true);
    expect(transitioned?.status).toBe('pending_approval');
    expect(transitioned?.reminderSentAt?.toISOString()).toBe('2026-04-05T12:10:00.000Z');
    expect(rejectedTransition).toBeNull();
    expect(replacedByOriginal?.mediaBatchJson).toEqual(nextMediaBatch);
    expect(resolvedReminder).toEqual({
      candidateId: created.id,
      candidateStatus: 'pending_approval',
      messageKind: 'reminder',
    });
    expect(controlMessages.map((message) => ({ telegramMessageId: message.telegramMessageId, messageKind: message.messageKind }))).toEqual([
      { telegramMessageId: '9001', messageKind: 'draft' },
      { telegramMessageId: '9002', messageKind: 'reminder' },
    ]);
  });

  it('gets and sets runtime state', async () => {
    const runtimeStateRepository = createRuntimeStateRepository(database.pool);

    expect(await runtimeStateRepository.getState('tick')).toBeNull();

    const inserted = await runtimeStateRepository.setState('tick', { cursor: '123' });
    const updated = await runtimeStateRepository.setState('tick', { cursor: '456', mode: 'draft' });
    const fetched = await runtimeStateRepository.getState('tick');
    const countResult = await database.pool.query<{ count: string }>('select count(*) from sp_runtime_state');

    expect(inserted.stateJson).toEqual({ cursor: '123' });
    expect(updated.stateJson).toEqual({ cursor: '456', mode: 'draft' });
    expect(fetched?.stateJson).toEqual({ cursor: '456', mode: 'draft' });
    expect(countResult.rows[0]?.count).toBe('1');
  });

  it('inserts published posts', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const publishedPostsRepository = createPublishedPostsRepository(database.pool);
    const candidate = await candidatesRepository.createCandidate({
      triggerType: 'manual',
      candidateType: 'event_summary',
      status: 'approved',
    });

    const publishedPost = await publishedPostsRepository.insertPublishedPost({
      candidateId: candidate.id,
      postedAt: new Date('2026-04-05T12:20:00.000Z'),
      xPostId: '1900000000000000000',
      postType: 'tweet',
      finalText: 'shipped a real test harness',
      quoteTargetUrl: 'https://x.com/example/status/2',
      mediaAttached: false,
      publisherResponse: { id: '1900000000000000000' },
    });
    const countResult = await database.pool.query<{ count: string }>('select count(*) from sp_published_posts');

    expect(publishedPost.candidateId).toBe(candidate.id);
    expect(publishedPost.finalText).toBe('shipped a real test harness');
    expect(publishedPost.publisherResponse).toEqual({ id: '1900000000000000000' });
    expect(countResult.rows[0]?.count).toBe('1');
  });

  it('dedupes telegram actions by telegram update id', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const telegramActionsRepository = createTelegramActionsRepository(database.pool);
    const candidate = await candidatesRepository.createCandidate({
      triggerType: 'manual',
      candidateType: 'event_summary',
      status: 'pending_approval',
    });

    const first = await telegramActionsRepository.recordAction({
      candidateId: candidate.id,
      telegramUpdateId: '9001',
      action: 'approve',
      payload: '/approve',
    });
    const duplicate = await telegramActionsRepository.recordAction({
      candidateId: candidate.id,
      telegramUpdateId: '9001',
      action: 'approve',
      payload: '/approve changed',
    });
    const countResult = await database.pool.query<{ count: string }>('select count(*) from sp_telegram_actions');

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.payload).toBe('/approve');
    expect(countResult.rows[0]?.count).toBe('1');
  });
});
