import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/db/migrate';
import { createPool } from '../../../src/db/pool';
import { createCandidatesRepository } from '../../../src/db/repositories/candidates-repository';
import { createPublishedPostsRepository } from '../../../src/db/repositories/published-posts-repository';
import { upsertEvents } from '../../../src/normalization/upsert-events';
import { buildRecentContextPacket } from '../../../src/orchestrator/context-builder';
import { draftSelectedCandidate } from '../../../src/orchestrator/draft-candidate';
import {
  applyCandidateAction,
  getCandidateById,
} from '../../../src/orchestrator/state-machine';
import {
  runTick,
} from '../../../src/orchestrator/tick';
import {
  findDueWindowSlots,
  parseWindowsJson,
} from '../../../src/orchestrator/windows';
import { selectCandidate } from '../../../src/orchestrator/select-candidate';
import type { NormalizedEventInput } from '../../../src/normalization/types';
import type { XThreadLookupClient } from '../../../src/enrichment/x/client';
import { runDraftNow } from '../../../src/commands/draft-now';
import {
  formatCandidatePackageMessage,
} from '../../../src/telegram/command-parser';
import type {
  SendCandidatePackageInput,
  TelegramClient,
  TelegramMessage,
  TelegramUpdate,
} from '../../../src/telegram/client';

const execFileAsync = promisify(execFile);

type TestDatabase = {
  dataDirectory: string;
  pool: Pool;
};

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing required test value: ${label}`);
  }

  return value;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

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
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'auto-biographer-orchestrator-'));
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

function createXLookupClient(): XThreadLookupClient {
  return {
    async lookupThread(tweetId: string) {
      return {
        conversationId: tweetId,
        externalUrlExpansion: 'omitted_v1',
        posts: [
          {
            author: null,
            authorId: null,
            conversationId: tweetId,
            createdAt: '2026-04-15T11:00:00.000Z',
            externalUrls: [],
            id: tweetId,
            inReplyToUserId: null,
            lang: 'en',
            possiblySensitive: false,
            publicMetrics: null,
            raw: { id: tweetId },
            referencedTweets: [],
            text: 'Selected X post text',
          },
        ],
        rawById: {
          [tweetId]: { id: tweetId },
        },
        requestedAt: '2026-04-15T12:00:00.000Z',
        rootTweetId: tweetId,
        targetTweetId: tweetId,
        via: 'x-api-v2-bearer-token',
      };
    },
  };
}

async function seedEvents(pool: Pool, events: readonly NormalizedEventInput[]) {
  return upsertEvents(pool, events);
}

async function createPublishedPost(pool: Pool, input?: { postedAt?: Date }) {
  const candidatesRepository = createCandidatesRepository(pool);
  const publishedPostsRepository = createPublishedPostsRepository(pool);
  const candidate = await candidatesRepository.createCandidate({
    triggerType: 'scheduled',
    candidateType: 'event_summary',
    status: 'published',
  });

  return publishedPostsRepository.insertPublishedPost({
    candidateId: candidate.id,
    postedAt: input?.postedAt ?? new Date('2026-04-15T11:45:00.000Z'),
    postType: 'tweet',
    finalText: 'Shipped a clean orchestrator packet yesterday.',
    quoteTargetUrl: 'https://x.com/example/status/999',
    publisherResponse: { ok: true },
  });
}

function atLocal(value: string): Date {
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    return new Date(value);
  }

  return new Date(`${value}-04:00`);
}

function createStubTelegramClient(input: { chatId: number }) {
  const sentPackages: SendCandidatePackageInput[] = [];
  const sentMessages: TelegramMessage[] = [];
  const queuedUpdates: TelegramUpdate[][] = [];
  let nextMessageId = 8000;

  const client: TelegramClient = {
    async getUpdates() {
      return queuedUpdates.shift() ?? [];
    },

    async sendMessage(message) {
      const sentMessage: TelegramMessage = {
        message_id: nextMessageId,
        chat: {
          id: input.chatId,
          type: 'private',
        },
        date: Math.floor(Date.now() / 1000),
        text: message.text,
      };

      nextMessageId += 1;
      sentMessages.push(sentMessage);
      return sentMessage;
    },

    async sendCandidatePackage(candidatePackage) {
      sentPackages.push(candidatePackage);
      return this.sendMessage({
        text: formatCandidatePackageMessage(candidatePackage),
        disableWebPagePreview: true,
      });
    },

    async getFile(fileId) {
      return {
        fileId,
        filePath: `${fileId}.jpg`,
        downloadUrl: `https://example.com/${fileId}.jpg`,
      };
    },
  };

  return {
    client,
    sentPackages,
    sentMessages,
    enqueueUpdates(updates: TelegramUpdate[]) {
      queuedUpdates.push(updates);
    },
  };
}

function createControlReplyUpdate(input: {
  updateId: number;
  chatId: number;
  fromUserId?: number;
  text: string;
  replyToMessage: TelegramMessage;
}): TelegramUpdate {
  return {
    update_id: input.updateId,
    message: {
      message_id: input.updateId + 100,
      chat: {
        id: input.chatId,
        type: 'private',
      },
      from: {
        id: input.fromUserId ?? 42,
        is_bot: false,
      },
      text: input.text,
      reply_to_message: {
        message_id: input.replyToMessage.message_id,
        text: input.replyToMessage.text,
      },
    },
  };
}

function createPhotoReplyUpdate(input: {
  updateId: number;
  chatId: number;
  messageId: number;
  replyMessageId: number;
  mediaGroupId?: string | null | undefined;
  photoIds: Array<{
    fileId: string;
    fileUniqueId: string;
    width: number;
    height: number;
  }>;
}): TelegramUpdate {
  return {
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      chat: {
        id: input.chatId,
        type: 'private',
      },
      from: {
        id: 42,
        is_bot: false,
      },
      media_group_id: input.mediaGroupId ?? undefined,
      photo: input.photoIds.map((photo) => ({
        file_id: photo.fileId,
        file_unique_id: photo.fileUniqueId,
        width: photo.width,
        height: photo.height,
      })),
      reply_to_message: {
        message_id: input.replyMessageId,
      },
    },
  };
}

describe('orchestrator Task 10 flow', () => {
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

  it('builds one recent context packet from the last 16 hours, excludes used sources, and includes recent published posts', async () => {
    const now = new Date('2026-04-15T12:00:00.000Z');
    const candidatesRepository = createCandidatesRepository(database.pool);
    const seededEvents = await seedEvents(database.pool, [
      {
        source: 'slack_message',
        sourceId: 'slack-message-used',
        occurredAt: new Date('2026-04-15T08:00:00.000Z'),
        author: 'dylanvu',
        rawText: 'This should be excluded after publication',
      },
      {
        source: 'slack_message',
        sourceId: 'slack-message-fresh',
        occurredAt: new Date('2026-04-15T10:30:00.000Z'),
        author: 'dylanvu',
        rawText: 'Fresh Slack message inside the rolling window',
      },
      {
        source: 'slack_link',
        sourceId: 'slack-link-fresh',
        occurredAt: new Date('2026-04-15T11:15:00.000Z'),
        author: 'dylanvu',
        title: 'Fresh Slack link',
        rawText: 'A useful write-up',
        rawPayload: {
          canonicalUrl: 'https://example.com/post',
          domain: 'example.com',
          finalUrl: 'https://example.com/post?utm_source=slack',
          sourceUrl: 'https://example.com/post',
        },
        artifacts: [
          {
            artifactType: 'text',
            artifactKey: 'captured_text',
            contentText: 'Captured readable text',
            sourceUrl: 'https://example.com/post',
          },
        ],
      },
      {
        source: 'agent_conversation',
        sourceId: 'innies-fresh',
        occurredAt: new Date('2026-04-15T09:15:00.000Z'),
        author: 'shirtless',
        summary: 'Innies session about the orchestration rollout',
        artifacts: [
          {
            artifactType: 'conversation_excerpt',
            artifactKey: 'request:1',
            contentText: 'We shipped the first cut',
          },
        ],
      },
      {
        source: 'github',
        sourceId: 'github-fresh',
        occurredAt: new Date('2026-04-15T07:30:00.000Z'),
        author: 'dylanvu',
        title: 'auto-biographer push',
        summary: 'Added orchestrator support',
        artifacts: [
          {
            artifactType: 'commit',
            artifactKey: 'abc123',
            contentText: 'feat: add orchestrator support',
          },
        ],
      },
      {
        source: 'github',
        sourceId: 'github-old',
        occurredAt: new Date('2026-04-14T19:59:00.000Z'),
        author: 'dylanvu',
        summary: 'Too old for the rolling window',
      },
    ]);
    const usedSlackMessage = requireValue(seededEvents[0], 'usedSlackMessage');
    const freshSlackMessage = requireValue(seededEvents[1], 'freshSlackMessage');
    const freshSlackLink = requireValue(seededEvents[2], 'freshSlackLink');
    const freshInnies = requireValue(seededEvents[3], 'freshInnies');
    const freshGitHub = requireValue(seededEvents[4], 'freshGitHub');
    const oldGitHub = requireValue(seededEvents[5], 'oldGitHub');

    const publishedPost = await createPublishedPost(database.pool);
    const activePendingCandidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'pending_approval',
      finalPostText: 'Shipped the first bounded source sync pass.',
      mediaRequest: 'terminal screenshot of the sync timings',
    });
    const activeRemindedCandidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'work_update',
      status: 'reminded',
      finalPostText: 'Tightened Hermes stdout parsing for one-shot runs.',
    });
    const activeHeldCandidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'quote_post',
      status: 'held',
      finalPostText: 'Held quote tweet about a public launch post.',
      quoteTargetUrl: 'https://x.com/example/status/222',
    });
    await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'skipped',
      finalPostText: 'This stale skipped draft should stay out of selector context.',
    });

    await database.pool.query(
      `
        update sp_post_candidates
        set created_at = $2,
            updated_at = $2
        where id = $1
      `,
      [activePendingCandidate.id, new Date('2026-04-15T09:10:00.000Z')],
    );
    await database.pool.query(
      `
        update sp_post_candidates
        set created_at = $2,
            updated_at = $2
        where id = $1
      `,
      [activeRemindedCandidate.id, new Date('2026-04-15T10:20:00.000Z')],
    );
    await database.pool.query(
      `
        update sp_post_candidates
        set created_at = $2,
            updated_at = $2
        where id = $1
      `,
      [activeHeldCandidate.id, new Date('2026-04-15T11:40:00.000Z')],
    );
    await database.pool.query(
      `
        insert into sp_source_usage (event_id, artifact_id, published_post_id)
        values ($1, $2, $3)
      `,
      [
        usedSlackMessage.event.id,
        null,
        publishedPost.id,
      ],
    );

    const context = await buildRecentContextPacket({
      db: database.pool,
      now: () => now,
    });

    expect(context.windowStart).toBe('2026-04-14T20:00:00.000Z');
    expect(context.windowEnd).toBe('2026-04-15T12:00:00.000Z');
    expect(context.events.map((event) => event.sourceId)).toEqual([
      freshSlackLink.event.sourceId,
      freshSlackMessage.event.sourceId,
      freshInnies.event.sourceId,
      freshGitHub.event.sourceId,
    ]);
    expect(context.events.map((event) => event.source)).toEqual([
      'slack_link',
      'slack_message',
      'agent_conversation',
      'github',
    ]);
    expect(context.events.some((event) => event.sourceId === usedSlackMessage.event.sourceId)).toBe(false);
    expect(context.events.some((event) => event.sourceId === oldGitHub.event.sourceId)).toBe(false);
    expect(context.recentPublishedPosts).toEqual([
      expect.objectContaining({
        id: Number(publishedPost.id),
        finalText: 'Shipped a clean orchestrator packet yesterday.',
        postedAt: '2026-04-15T11:45:00.000Z',
        quoteTargetUrl: 'https://x.com/example/status/999',
      }),
    ]);
    expect(context.pendingApprovalCandidates).toEqual([
      {
        id: Number(activeHeldCandidate.id),
        status: 'held',
        candidateType: 'quote_post',
        createdAt: '2026-04-15T11:40:00.000Z',
        finalPostText: 'Held quote tweet about a public launch post.',
        quoteTargetUrl: 'https://x.com/example/status/222',
        mediaRequest: null,
      },
      {
        id: Number(activeRemindedCandidate.id),
        status: 'reminded',
        candidateType: 'work_update',
        createdAt: '2026-04-15T10:20:00.000Z',
        finalPostText: 'Tightened Hermes stdout parsing for one-shot runs.',
        quoteTargetUrl: null,
        mediaRequest: null,
      },
      {
        id: Number(activePendingCandidate.id),
        status: 'pending_approval',
        candidateType: 'ship_update',
        createdAt: '2026-04-15T09:10:00.000Z',
        finalPostText: 'Shipped the first bounded source sync pass.',
        quoteTargetUrl: null,
        mediaRequest: 'terminal screenshot of the sync timings',
      },
    ]);
    expect(context.events[0]?.artifacts).toEqual([
      expect.objectContaining({
        artifactKey: 'captured_text',
        artifactType: 'text',
      }),
    ]);
  });

  it('persists a selector skip cleanly and stops before drafting', async () => {
    const now = new Date('2026-04-15T12:00:00.000Z');

    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-fresh',
        occurredAt: new Date('2026-04-15T11:50:00.000Z'),
        author: 'dylanvu',
        summary: 'Fresh GitHub activity',
      },
    ]);

    const context = await buildRecentContextPacket({
      db: database.pool,
      now: () => now,
    });
    const runSelector = vi.fn(async () => ({
      decision: 'skip' as const,
      reason: 'Nothing distinct enough to publish yet',
    }));

    const result = await selectCandidate({
      db: database.pool,
      context,
      triggerType: 'scheduled',
      runSelector,
    });

    expect(runSelector).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      outcome: 'skip',
      candidate: {
        status: 'selector_skipped',
        candidateType: 'skip',
      },
      selectorResult: {
        decision: 'skip',
      },
    });

    const candidates = await database.pool.query<{
      status: string;
      candidate_type: string;
      selector_output_json: unknown;
    }>(
      `
        select status, candidate_type, selector_output_json
        from sp_post_candidates
      `,
    );
    const candidateSources = await database.pool.query<{ count: string }>(
      'select count(*) from sp_candidate_sources',
    );

    expect(candidates.rows).toEqual([
      {
        status: 'selector_skipped',
        candidate_type: 'skip',
        selector_output_json: {
          decision: 'skip',
          reason: 'Nothing distinct enough to publish yet',
        },
      },
    ]);
    expect(candidateSources.rows[0]?.count).toBe('0');
  });

  it('persists selected events even when the selector returns no artifact ids', async () => {
    const now = new Date('2026-04-15T12:00:00.000Z');
    const seededEvents = await seedEvents(database.pool, [
      {
        source: 'slack_message',
        sourceId: 'slack-message-event-only',
        occurredAt: new Date('2026-04-15T11:10:00.000Z'),
        author: 'dylanvu',
        rawText: 'A fresh message with no artifact requirement',
      },
      {
        source: 'github',
        sourceId: 'github-event-only',
        occurredAt: new Date('2026-04-15T10:40:00.000Z'),
        author: 'dylanvu',
        summary: 'A clean event-only provenance case',
        artifacts: [
          {
            artifactType: 'commit',
            artifactKey: 'event-only-proof',
            contentText: 'This artifact exists but was not selected',
          },
        ],
      },
    ]);
    const slackMessageEvent = requireValue(seededEvents[0], 'slackMessageEvent');
    const githubEvent = requireValue(seededEvents[1], 'githubEvent');

    const context = await buildRecentContextPacket({
      db: database.pool,
      now: () => now,
    });
    const runSelector = vi.fn(async () => ({
      decision: 'select' as const,
      candidate_type: 'event_summary',
      angle: 'Keep provenance for event-only selections',
      why_interesting: 'Hermes can select events without artifacts',
      source_event_ids: [Number(slackMessageEvent.event.id), Number(githubEvent.event.id)],
      artifact_ids: [],
      primary_anchor: 'The selected events should still persist in provenance',
      supporting_points: ['No placeholder artifacts', 'No dropped event rows'],
      quote_target: null,
      suggested_media_kind: null,
      suggested_media_request: null,
    }));

    const selected = await selectCandidate({
      db: database.pool,
      context,
      triggerType: 'scheduled',
      runSelector,
    });

    expect(selected.outcome).toBe('select');
    if (selected.outcome !== 'select') {
      throw new Error('Expected a selected candidate');
    }

    const candidateSources = await database.pool.query<{
      candidate_id: string;
      event_id: string;
      artifact_id: string | null;
    }>(
      `
        select candidate_id, event_id, artifact_id
        from sp_candidate_sources
        where candidate_id = $1
        order by event_id asc, artifact_id asc nulls first
      `,
      [selected.candidate.id],
    );

    expect(candidateSources.rows).toEqual([
      {
        candidate_id: selected.candidate.id,
        event_id: slackMessageEvent.event.id,
        artifact_id: null,
      },
      {
        candidate_id: selected.candidate.id,
        event_id: githubEvent.event.id,
        artifact_id: null,
      },
    ]);
  });

  it('disables quote tweets while still persisting selected sources and returning one Telegram-ready package after drafting', async () => {
    const now = new Date('2026-04-15T12:00:00.000Z');
    const seededEvents = await seedEvents(database.pool, [
      {
        source: 'slack_link',
        sourceId: 'slack-link-x',
        occurredAt: new Date('2026-04-15T11:00:00.000Z'),
        author: 'dylanvu',
        title: 'Quoted X post',
        rawText: 'The linked X post matters',
        rawPayload: {
          canonicalUrl: 'https://x.com/dylanvu/status/1234567890123456789',
          domain: 'x.com',
          finalUrl: 'https://x.com/dylanvu/status/1234567890123456789?s=20',
          sourceUrl: 'https://x.com/dylanvu/status/1234567890123456789',
        },
        artifacts: [
          {
            artifactType: 'text',
            artifactKey: 'captured_text',
            contentText: 'Linked X post summary',
            sourceUrl: 'https://x.com/dylanvu/status/1234567890123456789',
          },
        ],
      },
      {
        source: 'github',
        sourceId: 'github-sha',
        occurredAt: new Date('2026-04-15T10:00:00.000Z'),
        author: 'dylanvu',
        title: 'auto-biographer push',
        summary: 'Added the first orchestration layer',
        artifacts: [
          {
            artifactType: 'commit',
            artifactKey: 'def456',
            contentText: 'feat: add candidate selection and drafting',
          },
        ],
      },
    ]);
    const slackLinkEvent = requireValue(seededEvents[0], 'slackLinkEvent');
    const githubEvent = requireValue(seededEvents[1], 'githubEvent');
    const slackLinkArtifact = requireValue(slackLinkEvent.artifacts[0], 'slackLinkArtifact');
    const githubArtifact = requireValue(githubEvent.artifacts[0], 'githubArtifact');

    const context = await buildRecentContextPacket({
      db: database.pool,
      now: () => now,
    });
    const xLookupClient: XThreadLookupClient = {
      lookupThread: vi.fn(createXLookupClient().lookupThread),
    };
    const runSelector = vi.fn(async () => ({
      decision: 'select' as const,
      candidate_type: 'ship_update',
      angle: 'Show the first orchestration layer',
      why_interesting: 'The posting pipeline can now assemble, select, and draft',
      source_event_ids: [
        Number(slackLinkEvent.event.id),
        Number(githubEvent.event.id),
        Number(slackLinkEvent.event.id),
      ],
      artifact_ids: [
        Number(slackLinkArtifact.id),
        Number(githubArtifact.id),
        Number(slackLinkArtifact.id),
      ],
      primary_anchor: 'The new orchestration layer exists and is tested',
      supporting_points: ['It assembles context', 'It drafts a Telegram-ready package'],
      quote_target: 'https://x.com/dylanvu/status/1234567890123456789',
      suggested_media_kind: null,
      suggested_media_request: null,
    }));
    const selected = await selectCandidate({
      db: database.pool,
      context,
      triggerType: 'scheduled',
      runSelector,
      xLookupClient,
    });

    expect(selected.outcome).toBe('select');
    if (selected.outcome !== 'select') {
      throw new Error('Expected a selected candidate');
    }

    expect(selected.selectedPacket.quoteTargetEnrichment).toBeNull();
    expect(selected.selectedPacket.selection.quoteTargetUrl).toBeNull();
    expect(xLookupClient.lookupThread).not.toHaveBeenCalled();

    const runDrafter = vi.fn(async (input: typeof selected.selectedPacket) => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: `Built the first semiautonomous X orchestrator layer. ${input.selection.primaryAnchor}`,
      candidate_type: input.selection.candidateType,
      quote_target_url: 'https://x.com/dylanvu/status/1234567890123456789',
      why_chosen: 'It is concrete, recent, and grounded in real work.',
      receipts: ['Context packet built', 'Selector persisted', 'Telegram package ready'],
      media_request: 'screenshot of the new integration test passing',
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));
    const drafted = await draftSelectedCandidate({
      db: database.pool,
      selected,
      runDrafter,
      resolvePublicRepoLinkUrl: vi.fn(async ({ repoUrl }) => repoUrl),
    });

    expect(runDrafter).toHaveBeenCalledOnce();
    expect(drafted).toMatchObject({
      outcome: 'ready',
      candidate: {
        status: 'pending_approval',
      },
      package: {
        kind: 'candidate_package',
        candidateId: selected.candidate.id,
        candidateType: 'ship_update',
        deliveryKind: 'single_post',
        draftText:
          'Built the first semiautonomous X orchestrator layer. The new orchestration layer exists and is tested',
        quoteTargetUrl: null,
        mediaRequest: 'screenshot of the new integration test passing',
        allowedCommands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
      },
    });

    const candidateSources = await database.pool.query<{
      candidate_id: string;
      event_id: string;
      artifact_id: string | null;
    }>(
      `
        select candidate_id, event_id, artifact_id
        from sp_candidate_sources
        where candidate_id = $1
        order by event_id asc, artifact_id asc nulls first
      `,
      [selected.candidate.id],
    );
    const persistedCandidate = await database.pool.query<{
      status: string;
      final_post_text: string | null;
      quote_target_url: string | null;
      media_request: string | null;
      drafter_output_json: unknown;
    }>(
      `
        select
          status,
          final_post_text,
          quote_target_url,
          media_request,
          drafter_output_json
        from sp_post_candidates
      `,
    );

    expect(candidateSources.rows).toEqual([
      {
        candidate_id: selected.candidate.id,
        event_id: slackLinkEvent.event.id,
        artifact_id: null,
      },
      {
        candidate_id: selected.candidate.id,
        event_id: slackLinkEvent.event.id,
        artifact_id: slackLinkArtifact.id,
      },
      {
        candidate_id: selected.candidate.id,
        event_id: githubEvent.event.id,
        artifact_id: null,
      },
      {
        candidate_id: selected.candidate.id,
        event_id: githubEvent.event.id,
        artifact_id: githubArtifact.id,
      },
    ]);
    expect(persistedCandidate.rows).toEqual([
      {
        status: 'pending_approval',
        final_post_text:
          'Built the first semiautonomous X orchestrator layer. The new orchestration layer exists and is tested',
        quote_target_url: null,
        media_request: 'screenshot of the new integration test passing',
        drafter_output_json: {
          decision: 'success',
          delivery_kind: 'single_post',
          draft_text:
            'Built the first semiautonomous X orchestrator layer. The new orchestration layer exists and is tested',
          candidate_type: 'ship_update',
          quote_target_url: 'https://x.com/dylanvu/status/1234567890123456789',
          why_chosen: 'It is concrete, recent, and grounded in real work.',
          receipts: ['Context packet built', 'Selector persisted', 'Telegram package ready'],
          media_request: 'screenshot of the new integration test passing',
          allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
        },
      },
    ]);
  });

  it('evaluates broad scheduled windows with deterministic jitter', async () => {
    const windows = parseWindowsJson([
      {
        name: 'weekday-morning',
        days: ['wed'],
        start: '10:00',
        end: '11:00',
      },
    ]);

    const beforeDue = findDueWindowSlots({
      windows,
      now: atLocal('2026-04-15T10:29:00'),
      claimedSlotIds: new Set<string>(),
      randomFractionForSlot: () => 0.5,
    });
    const atDue = findDueWindowSlots({
      windows,
      now: atLocal('2026-04-15T10:30:00'),
      claimedSlotIds: new Set<string>(),
      randomFractionForSlot: () => 0.5,
    });

    expect(beforeDue).toEqual([]);
    expect(atDue).toHaveLength(1);
    expect(atDue[0]).toMatchObject({
      slotId: 'weekday-morning:2026-04-15',
      windowName: 'weekday-morning',
    });
    expect(atDue[0]?.scheduledFor.getTime()).toBe(atLocal('2026-04-15T10:30:00').getTime());
  });

  it('promotes repo-backed original drafts into thread delivery with a repo-link reply', async () => {
    const now = new Date('2026-04-15T12:00:00.000Z');
    const seededEvents = await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-thread-draft',
        occurredAt: new Date('2026-04-15T11:10:00.000Z'),
        author: 'dylanvu',
        title: 'auto-biographer push',
        summary: 'Built the x-post scraper',
        urlOrLocator: 'https://github.com/dylanvu/auto-biographer/commit/abc123',
        tags: ['repo:dylanvu/auto-biographer', 'action:push'],
        rawPayload: {
          repo: 'dylanvu/auto-biographer',
        },
      },
    ]);
    const githubEvent = requireValue(seededEvents[0], 'githubEvent');

    const context = await buildRecentContextPacket({
      db: database.pool,
      now: () => now,
    });
    const runSelector = vi.fn(async () => ({
      decision: 'select' as const,
      candidate_type: 'ship_update',
      angle: 'Show the shipped project',
      why_interesting: 'The repo-backed change is live',
      source_event_ids: [Number(githubEvent.event.id)],
      artifact_ids: [],
      primary_anchor: 'Built the x-post scraper',
      supporting_points: ['Repo-backed change', 'Fresh push'],
      quote_target: null,
      suggested_media_kind: 'image',
      suggested_media_request: 'screenshot of the x-post scraper output table',
    }));
    const selected = await selectCandidate({
      db: database.pool,
      context,
      triggerType: 'scheduled',
      runSelector,
    });

    expect(selected.outcome).toBe('select');
    if (selected.outcome !== 'select') {
      throw new Error('Expected a selected candidate');
    }

    expect(selected.selectedPacket.repoLinkUrl).toBe('https://github.com/dylanvu/auto-biographer');

    const runDrafter = vi.fn(async () => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: 'Built an internal scraper that pulls our X posts into an xt_posts table.',
      candidate_type: 'ship_update',
      quote_target_url: null,
      why_chosen: 'Fresh shipped work with a concrete repo.',
      receipts: ['repo-backed event'],
      media_request: null,
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));
    const drafted = await draftSelectedCandidate({
      db: database.pool,
      selected,
      runDrafter,
      resolvePublicRepoLinkUrl: vi.fn(async ({ repoUrl }) => repoUrl),
    });

    expect(drafted).toMatchObject({
      outcome: 'ready',
      package: {
        deliveryKind: 'thread',
        draftText: 'Built an internal scraper that pulls our X posts into an xt_posts table.',
        threadReplyText: 'https://github.com/dylanvu/auto-biographer',
        mediaRequest: 'screenshot of the x-post scraper output table',
      },
    });
  });

  it('keeps repo-backed originals as a single post when the repo is not public', async () => {
    const now = new Date('2026-04-15T10:30:00.000Z');
    const seededEvents = await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-private-repo-thread',
        occurredAt: new Date('2026-04-15T10:20:00.000Z'),
        author: 'dylanvu',
        title: 'secret-project push',
        summary: 'Shipped a private project',
        urlOrLocator: 'https://github.com/dylanvu/secret-project/commit/abc123',
        tags: ['repo:dylanvu/secret-project', 'action:push'],
        rawPayload: {
          repo: 'dylanvu/secret-project',
        },
      },
    ]);
    const githubEvent = requireValue(seededEvents[0], 'githubEvent');

    const context = await buildRecentContextPacket({
      db: database.pool,
      now: () => now,
    });
    const runSelector = vi.fn(async () => ({
      decision: 'select' as const,
      candidate_type: 'ship_update',
      angle: 'Show the shipped private project',
      why_interesting: 'The project shipped but the repo is private',
      source_event_ids: [Number(githubEvent.event.id)],
      artifact_ids: [],
      primary_anchor: 'Shipped a private project',
      supporting_points: ['Private repo', 'Fresh push'],
      quote_target: null,
      suggested_media_kind: 'image',
      suggested_media_request: 'screenshot of the shipped feature',
    }));
    const selected = await selectCandidate({
      db: database.pool,
      context,
      triggerType: 'scheduled',
      runSelector,
    });

    expect(selected.outcome).toBe('select');
    if (selected.outcome !== 'select') {
      throw new Error('Expected a selected candidate');
    }

    const runDrafter = vi.fn(async () => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: 'Shipped a private project update without leaking the repo.',
      candidate_type: 'ship_update',
      quote_target_url: null,
      why_chosen: 'Fresh shipped work.',
      receipts: ['private repo event'],
      media_request: null,
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));
    const drafted = await draftSelectedCandidate({
      db: database.pool,
      selected,
      runDrafter,
      resolvePublicRepoLinkUrl: vi.fn(async () => null),
    });

    expect(drafted).toMatchObject({
      outcome: 'ready',
      package: {
        deliveryKind: 'single_post',
        draftText: 'Shipped a private project update without leaking the repo.',
        threadReplyText: null,
        mediaRequest: 'screenshot of the shipped feature',
      },
    });
  });

  it('evaluates scheduled windows in America/New_York even when the host timezone is UTC', async () => {
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const windowsModuleUrl = new URL('../../../src/orchestrator/windows.ts', import.meta.url).href;
    const script = `
      import { findDueWindowSlots, parseWindowsJson } from ${JSON.stringify(windowsModuleUrl)};

      const windows = parseWindowsJson([
        {
          name: 'weekday-morning',
          days: ['wed'],
          start: '10:00',
          end: '11:00',
        },
      ]);
      const due = findDueWindowSlots({
        windows,
        now: new Date('2026-04-15T13:30:00.000Z'),
        claimedSlotIds: new Set(),
        randomFractionForSlot: () => 0.5,
      });

      process.stdout.write(
        JSON.stringify(
          due.map((slot) => ({
            slotId: slot.slotId,
            scheduledFor: slot.scheduledFor.toISOString(),
          })),
        ),
      );
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--eval', script],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          TZ: 'UTC',
        },
      },
    );

    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('sends a Telegram package for a newly ready scheduled draft and only one reminder at 10 minutes', async () => {
    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-scheduled-draft',
        occurredAt: new Date('2026-04-15T09:55:00.000Z'),
        author: 'dylanvu',
        title: 'auto-biographer push',
        summary: 'Scheduled draft path',
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const syncSource = {
      name: 'seeded-events',
      sync: vi.fn(async () => []),
    };
    const runSelector = vi.fn(async (context: Awaited<ReturnType<typeof buildRecentContextPacket>>) => ({
      decision: 'select' as const,
      candidate_type: 'ship_update',
      angle: 'Send the scheduled slot',
      why_interesting: 'This slot should yield one draft and one reminder',
      source_event_ids: [requireValue(context.events[0], 'context.events[0]').id],
      artifact_ids: [],
      primary_anchor: 'The scheduled slot is due',
      supporting_points: ['One package', 'One reminder'],
      quote_target: null,
      suggested_media_kind: null,
      suggested_media_request: null,
    }));
    const runDrafter = vi.fn(async () => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: 'Scheduled draft ready for review.',
      candidate_type: 'ship_update',
      quote_target_url: null,
      why_chosen: 'The scheduler picked a real slot.',
      receipts: ['window due', 'selector ok', 'drafter ok'],
      media_request: null,
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));
    const windowsJson = [
      {
        name: 'weekday-morning',
        days: ['wed'],
        start: '10:00',
        end: '11:00',
      },
    ];

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:30:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });

    expect(syncSource.sync).toHaveBeenCalledOnce();
    expect(runSelector).toHaveBeenCalledOnce();
    expect(runDrafter).toHaveBeenCalledOnce();
    expect(telegram.sentPackages).toHaveLength(1);
    expect(telegram.sentPackages[0]).toMatchObject({
      candidateType: 'ship_update',
      draftText: 'Scheduled draft ready for review.',
    });

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:39:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });
    expect(telegram.sentPackages).toHaveLength(1);

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:40:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });
    expect(telegram.sentPackages).toHaveLength(2);

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:44:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });
    expect(telegram.sentPackages).toHaveLength(2);

    const candidates = await database.pool.query<{
      id: string;
      status: string;
      deadline_at: Date | null;
      reminder_sent_at: Date | null;
    }>(
      `
        select id, status, deadline_at, reminder_sent_at
        from sp_post_candidates
        order by id asc
      `,
    );
    const slotClaims = await database.pool.query<{ state_key: string }>(
      `
        select state_key
        from sp_runtime_state
        where state_key like 'scheduled_window_slot:%'
      `,
    );

    expect(candidates.rows).toHaveLength(1);
    expect(candidates.rows[0]?.status).toBe('reminded');
    expect(candidates.rows[0]?.deadline_at?.getTime()).toBe(atLocal('2026-04-15T10:45:00').getTime());
    expect(candidates.rows[0]?.reminder_sent_at?.getTime()).toBe(atLocal('2026-04-15T10:40:00').getTime());
    expect(slotClaims.rows).toEqual([
      {
        state_key: 'scheduled_window_slot:weekday-morning:2026-04-15',
      },
    ]);
  });

  it('lets only one overlapping scheduled tick own a due slot', async () => {
    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-overlapping-scheduled-slot',
        occurredAt: new Date('2026-04-15T09:55:00.000Z'),
        author: 'dylanvu',
        summary: 'Overlapping ticks must not draft the same slot twice',
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const firstSelectorEntered = createDeferred<void>();
    const releaseFirstSelector = createDeferred<void>();
    const secondSelectorEntered = createDeferred<void>();
    let selectorCallCount = 0;
    const runSelector = vi.fn(async (context: Awaited<ReturnType<typeof buildRecentContextPacket>>) => {
      selectorCallCount += 1;

      if (selectorCallCount === 1) {
        firstSelectorEntered.resolve();
        await releaseFirstSelector.promise;
      } else {
        secondSelectorEntered.resolve();
      }

      return {
        decision: 'select' as const,
        candidate_type: 'ship_update',
        angle: 'Claim this scheduled slot once',
        why_interesting: 'Only one overlapping tick should own the slot',
        source_event_ids: [requireValue(context.events[0], 'context.events[0]').id],
        artifact_ids: [],
        primary_anchor: 'The slot is due exactly once',
        supporting_points: ['first tick claims', 'second tick exits'],
        quote_target: null,
        suggested_media_kind: null,
        suggested_media_request: null,
      };
    });
    const runDrafter = vi.fn(async () => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: 'Only one overlapping tick should produce this draft.',
      candidate_type: 'ship_update',
      quote_target_url: null,
      why_chosen: 'The slot owner should be unique.',
      receipts: ['slot claimed', 'selector ok', 'drafter ok'],
      media_request: null,
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));
    const windowsJson = [
      {
        name: 'weekday-morning',
        days: ['wed'],
        start: '10:00',
        end: '11:00',
      },
    ];
    const tickInput = {
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:30:00'),
      randomFractionForSlot: () => 0.5,
      runSelector,
      runDrafter,
    } as const;

    const firstTickPromise = runTick(tickInput);
    await firstSelectorEntered.promise;

    const secondTickPromise = runTick(tickInput);
    const overlapOutcome = await Promise.race([
      secondTickPromise.then(() => 'tick_finished' as const),
      secondSelectorEntered.promise.then(() => 'selector_started' as const),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 1000);
      }),
    ]);

    releaseFirstSelector.resolve();

    const [firstTickResult, secondTickResult] = await Promise.all([firstTickPromise, secondTickPromise]);
    const candidates = await database.pool.query<{ id: string; status: string }>(
      `
        select id, status
        from sp_post_candidates
        order by id asc
      `,
    );
    const slotState = await database.pool.query<{ state_json: unknown }>(
      `
        select state_json
        from sp_runtime_state
        where state_key = 'scheduled_window_slot:weekday-morning:2026-04-15'
      `,
    );

    expect(overlapOutcome).toBe('tick_finished');
    expect(firstTickResult.createdCandidateIds).toEqual(['1']);
    expect(secondTickResult.createdCandidateIds).toEqual([]);
    expect(runSelector).toHaveBeenCalledOnce();
    expect(runDrafter).toHaveBeenCalledOnce();
    expect(telegram.sentPackages).toHaveLength(1);
    expect(candidates.rows).toEqual([{ id: '1', status: 'pending_approval' }]);
    expect(slotState.rows).toEqual([
      {
        state_json: expect.objectContaining({
          slotId: 'weekday-morning:2026-04-15',
          status: 'completed',
          attemptCount: 1,
          candidateId: '1',
          ownerId: expect.any(String),
        }),
      },
    ]);
  });

  it('skips a scheduled slot cleanly when selector execution throws', async () => {
    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-selector-failure',
        occurredAt: new Date('2026-04-15T13:55:00.000Z'),
        author: 'dylanvu',
        summary: 'Selector failure should skip this slot',
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const runSelector = vi.fn(async () => {
      throw new Error('selector unavailable');
    });
    const runDrafter = vi.fn();
    const windowsJson = [
      {
        name: 'weekday-morning',
        days: ['wed'],
        start: '10:00',
        end: '11:00',
      },
    ];

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:30:00'),
      randomFractionForSlot: () => 0.5,
      runSelector,
      runDrafter,
    });
    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:31:00'),
      randomFractionForSlot: () => 0.5,
      runSelector,
      runDrafter,
    });

    const candidates = await database.pool.query<{ count: string }>('select count(*) from sp_post_candidates');
    const slotState = await database.pool.query<{ state_json: unknown }>(
      `
        select state_json
        from sp_runtime_state
        where state_key = 'scheduled_window_slot:weekday-morning:2026-04-15'
      `,
    );

    expect(runSelector).toHaveBeenCalledOnce();
    expect(runDrafter).not.toHaveBeenCalled();
    expect(telegram.sentPackages).toHaveLength(0);
    expect(candidates.rows[0]?.count).toBe('0');
    expect(slotState.rows).toEqual([
      {
        state_json: expect.objectContaining({
          slotId: 'weekday-morning:2026-04-15',
          status: 'skipped',
          outcome: 'selector_failed',
          attemptCount: 1,
          candidateId: null,
          errorDetails: 'selector unavailable',
        }),
      },
    ]);
  });

  it('sends a plain Telegram notification when a scheduled selector skip has no usable context', async () => {
    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const runSelector = vi.fn(async () => ({
      decision: 'skip' as const,
      reason: 'Nothing distinct enough to publish yet',
    }));
    const runDrafter = vi.fn();
    const windowsJson = [
      {
        name: 'weekday-morning',
        days: ['wed'],
        start: '10:00',
        end: '11:00',
      },
    ];

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:30:00'),
      randomFractionForSlot: () => 0.5,
      runSelector,
      runDrafter,
    });

    const candidate = await getCandidateById(database.pool, '1');

    expect(runSelector).toHaveBeenCalledOnce();
    expect(runDrafter).not.toHaveBeenCalled();
    expect(telegram.sentPackages).toHaveLength(0);
    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.sentMessages[0]?.text).toBe([
      'Skipped: selector',
      'Trigger: scheduled',
      'Type: skip',
      'Reason: Nothing distinct enough to publish yet',
      'Ref: 1',
    ].join('\n'));
    expect(candidate?.telegramMessageId).toBeNull();
    expect(candidate?.status).toBe('selector_skipped');
  });

  it('falls back from a scheduled selector skip when recent context exists', async () => {
    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-selector-skip-fallback',
        occurredAt: new Date('2026-04-15T13:55:00.000Z'),
        author: 'shirtlessfounder',
        title: 'auto-biographer push',
        summary: 'Shipped the scheduled fallback path',
        artifacts: [
          {
            artifactType: 'commit',
            artifactKey: 'abc123',
            contentText: 'feat: force scheduled fallback output',
          },
        ],
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const runSelector = vi.fn(async () => ({
      decision: 'skip' as const,
      reason: 'Nothing distinct enough to publish yet',
    }));
    const runDrafter = vi.fn(async () => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: 'Scheduled fallback draft ready for review.',
      candidate_type: 'work_update',
      quote_target_url: null,
      why_chosen: 'Scheduled runs should still surface the strongest recent work.',
      receipts: ['selector skipped', 'fallback selected recent context', 'drafter ok'],
      media_request: null,
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));
    const windowsJson = [
      {
        name: 'weekday-morning',
        days: ['wed'],
        start: '10:00',
        end: '11:00',
      },
    ];

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:30:00'),
      randomFractionForSlot: () => 0.5,
      runSelector,
      runDrafter,
    });

    const candidate = await getCandidateById(database.pool, '1');

    expect(runSelector).toHaveBeenCalledOnce();
    expect(runDrafter).toHaveBeenCalledOnce();
    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.sentPackages).toHaveLength(1);
    expect(telegram.sentPackages[0]).toMatchObject({
      candidateId: '1',
      draftText: 'Scheduled fallback draft ready for review.',
    });
    expect(telegram.sentMessages[0]?.text).toContain('Scheduled fallback draft ready for review.');
    expect(candidate?.status).toBe('pending_approval');
    expect(candidate?.candidateType).toBe('ship_update');
  });

  it('retries a scheduled slot once after a drafter exception before finalizing it', async () => {
    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-drafter-retry',
        occurredAt: new Date('2026-04-15T13:55:00.000Z'),
        author: 'dylanvu',
        summary: 'First drafter failure should leave one retry',
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const runSelector = vi.fn(async (context: Awaited<ReturnType<typeof buildRecentContextPacket>>) => ({
      decision: 'select' as const,
      candidate_type: 'ship_update',
      angle: 'Retry the scheduled slot once',
      why_interesting: 'The first drafter failure should not burn the slot',
      source_event_ids: [requireValue(context.events[0], 'context.events[0]').id],
      artifact_ids: [],
      primary_anchor: 'One transient drafter outage',
      supporting_points: ['first attempt fails', 'second attempt succeeds'],
      quote_target: null,
      suggested_media_kind: null,
      suggested_media_request: null,
    }));
    const runDrafter = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary drafter outage'))
      .mockResolvedValueOnce({
        decision: 'success' as const,
        delivery_kind: 'single_post' as const,
        draft_text: 'Second attempt worked.',
        candidate_type: 'ship_update',
        quote_target_url: null,
        why_chosen: 'The retry path should still deliver one package.',
        receipts: ['selector ok', 'retry ok'],
        media_request: null,
        allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
      });
    const windowsJson = [
      {
        name: 'weekday-morning',
        days: ['wed'],
        start: '10:00',
        end: '11:00',
      },
    ];

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:30:00'),
      randomFractionForSlot: () => 0.5,
      runSelector,
      runDrafter,
    });

    const firstAttemptCandidate = await getCandidateById(database.pool, '1');
    const slotStateAfterFirstAttempt = await database.pool.query<{ state_json: unknown }>(
      `
        select state_json
        from sp_runtime_state
        where state_key = 'scheduled_window_slot:weekday-morning:2026-04-15'
      `,
    );

    expect(runSelector).toHaveBeenCalledOnce();
    expect(runDrafter).toHaveBeenCalledOnce();
    expect(firstAttemptCandidate?.status).toBe('drafter_skipped');
    expect(firstAttemptCandidate?.errorDetails).toContain('temporary drafter outage');
    expect(slotStateAfterFirstAttempt.rows).toEqual([
      {
        state_json: expect.objectContaining({
          slotId: 'weekday-morning:2026-04-15',
          status: 'retry_pending',
          attemptCount: 1,
          ownerId: expect.any(String),
          candidateId: '1',
          errorDetails: 'temporary drafter outage',
        }),
      },
    ]);

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:31:00'),
      randomFractionForSlot: () => 0.5,
      runSelector,
      runDrafter,
    });

    const finalSlotState = await database.pool.query<{ state_json: unknown }>(
      `
        select state_json
        from sp_runtime_state
        where state_key = 'scheduled_window_slot:weekday-morning:2026-04-15'
      `,
    );
    const candidates = await database.pool.query<{ id: string; status: string }>(
      `
        select id, status
        from sp_post_candidates
        order by id asc
      `,
    );

    expect(runSelector).toHaveBeenCalledTimes(2);
    expect(runDrafter).toHaveBeenCalledTimes(2);
    expect(telegram.sentPackages).toHaveLength(1);
    expect(telegram.sentPackages[0]?.draftText).toBe('Second attempt worked.');
    expect(finalSlotState.rows).toEqual([
      {
        state_json: expect.objectContaining({
          slotId: 'weekday-morning:2026-04-15',
          status: 'completed',
          outcome: 'draft_ready',
          attemptCount: 2,
          ownerId: expect.any(String),
          candidateId: '2',
          errorDetails: null,
        }),
      },
    ]);
    expect(candidates.rows).toEqual([
      { id: '1', status: 'drafter_skipped' },
      { id: '2', status: 'pending_approval' },
    ]);
  });

  it('runs on-demand drafts through the shared pipeline without timer-based auto-post progression', async () => {
    await seedEvents(database.pool, [
      {
        source: 'slack_message',
        sourceId: 'slack-draft-now',
        occurredAt: new Date('2026-04-15T12:55:00.000Z'),
        author: 'dylanvu',
        rawText: 'Draft this right now.',
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const syncSource = {
      name: 'seeded-events',
      sync: vi.fn(async () => []),
    };
    const runSelector = vi.fn(async (context: Awaited<ReturnType<typeof buildRecentContextPacket>>) => ({
      decision: 'select' as const,
      candidate_type: 'event_summary',
      angle: 'Draft on demand',
      why_interesting: 'On-demand drafts should share the same path',
      source_event_ids: [requireValue(context.events[0], 'context.events[0]').id],
      artifact_ids: [],
      primary_anchor: 'The draft-now path reuses the orchestrator',
      supporting_points: ['same selector', 'same drafter'],
      quote_target: null,
      suggested_media_kind: null,
      suggested_media_request: null,
    }));
    const runDrafter = vi.fn(async () => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: 'On-demand draft ready for review.',
      candidate_type: 'event_summary',
      quote_target_url: null,
      why_chosen: 'Draft-now should stop after package delivery.',
      receipts: ['selector ok', 'drafter ok'],
      media_request: null,
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));

    await runDraftNow({
      db: database.pool,
      telegramClient: telegram.client,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
      now: () => atLocal('2026-04-15T13:00:00'),
    });

    expect(syncSource.sync).toHaveBeenCalledOnce();
    expect(telegram.sentPackages).toHaveLength(1);

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson: [],
      now: () => atLocal('2026-04-15T13:30:00'),
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });

    const candidates = await database.pool.query<{
      trigger_type: string;
      status: string;
      deadline_at: Date | null;
    }>(
      `
        select trigger_type, status, deadline_at
        from sp_post_candidates
        order by id asc
      `,
    );

    expect(candidates.rows).toEqual([
      {
        trigger_type: 'on_demand',
        status: 'pending_approval',
        deadline_at: null,
      },
    ]);
    expect(telegram.sentPackages).toHaveLength(1);
  });

  it('sends a plain Telegram notification when an on-demand drafter skip is chosen', async () => {
    await seedEvents(database.pool, [
      {
        source: 'slack_message',
        sourceId: 'slack-draft-now-skip',
        occurredAt: new Date('2026-04-15T12:55:00.000Z'),
        author: 'dylanvu',
        rawText: 'Draft this right now, unless the drafter skips it.',
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const runSelector = vi.fn(async (context: Awaited<ReturnType<typeof buildRecentContextPacket>>) => ({
      decision: 'select' as const,
      candidate_type: 'event_summary',
      angle: 'Skip after selection',
      why_interesting: 'The drafter skip path should still notify Telegram',
      source_event_ids: [requireValue(context.events[0], 'context.events[0]').id],
      artifact_ids: [],
      primary_anchor: 'An on-demand skip should still be visible',
      supporting_points: ['selector selected', 'drafter skipped'],
      quote_target: null,
      suggested_media_kind: null,
      suggested_media_request: null,
    }));
    const runDrafter = vi.fn(async () => ({
      decision: 'skip' as const,
      reason: 'Not concrete enough to draft yet',
    }));

    const result = await runDraftNow({
      db: database.pool,
      telegramClient: telegram.client,
      runSelector,
      runDrafter,
      now: () => atLocal('2026-04-15T13:00:00'),
    });

    const candidate = await getCandidateById(database.pool, '1');

    expect(result).toEqual({ candidateId: '1' });
    expect(runSelector).toHaveBeenCalledOnce();
    expect(runDrafter).toHaveBeenCalledOnce();
    expect(telegram.sentPackages).toHaveLength(0);
    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.sentMessages[0]?.text).toBe([
      'Skipped: drafter',
      'Trigger: on_demand',
      'Type: event_summary',
      'Reason: Not concrete enough to draft yet',
      'Ref: 1',
    ].join('\n'));
    expect(candidate?.telegramMessageId).toBeNull();
    expect(candidate?.status).toBe('drafter_skipped');
  });

  it('applies skip and post-now as action-driven state transitions without publishing', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const pendingCandidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'pending_approval',
      deadlineAt: atLocal('2026-04-15T10:45:00'),
      finalPostText: 'Pending draft',
    });
    const heldCandidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'held',
      deadlineAt: atLocal('2026-04-15T10:45:00'),
      finalPostText: 'Held draft',
    });

    const skipped = await applyCandidateAction({
      db: database.pool,
      candidateId: pendingCandidate.id,
      action: 'skip',
      now: () => atLocal('2026-04-15T10:31:00'),
    });
    const postRequested = await applyCandidateAction({
      db: database.pool,
      candidateId: heldCandidate.id,
      action: 'post_now',
      now: () => atLocal('2026-04-15T10:31:00'),
    });

    expect(skipped.candidate?.status).toBe('skipped');
    expect(postRequested.candidate?.status).toBe('post_requested');
  });

  it('restricts edit actions to active approval states', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const activeCandidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'pending_approval',
      finalPostText: 'Pending draft',
    });
    const staleCandidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'skipped',
      finalPostText: 'Stale draft',
    });

    const activeEdit = await applyCandidateAction({
      db: database.pool,
      candidateId: activeCandidate.id,
      action: 'edit',
      payload: 'Updated active draft',
    });
    const staleEdit = await applyCandidateAction({
      db: database.pool,
      candidateId: staleCandidate.id,
      action: 'edit',
      payload: 'This should be ignored',
    });

    const refreshedActiveCandidate = await getCandidateById(database.pool, activeCandidate.id);
    const refreshedStaleCandidate = await getCandidateById(database.pool, staleCandidate.id);

    expect(activeEdit.applied).toBe(true);
    expect(refreshedActiveCandidate?.finalPostText).toBe('Updated active draft');
    expect(staleEdit.applied).toBe(false);
    expect(refreshedStaleCandidate?.finalPostText).toBe('Stale draft');
  });

  it('honors hold actions and suppresses future deadline-driven post progression', async () => {
    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-hold-flow',
        occurredAt: new Date('2026-04-15T09:55:00.000Z'),
        author: 'dylanvu',
        summary: 'Hold the scheduled candidate',
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const syncSource = {
      name: 'seeded-events',
      sync: vi.fn(async () => []),
    };
    const runSelector = vi.fn(async (context: Awaited<ReturnType<typeof buildRecentContextPacket>>) => ({
      decision: 'select' as const,
      candidate_type: 'ship_update',
      angle: 'Allow hold before deadline',
      why_interesting: 'Held drafts must not advance automatically',
      source_event_ids: [requireValue(context.events[0], 'context.events[0]').id],
      artifact_ids: [],
      primary_anchor: 'A hold should stop the timer path',
      supporting_points: ['hold action', 'deadline reached'],
      quote_target: null,
      suggested_media_kind: null,
      suggested_media_request: null,
    }));
    const runDrafter = vi.fn(async () => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: 'Held draft ready for review.',
      candidate_type: 'ship_update',
      quote_target_url: null,
      why_chosen: 'This candidate should pause cleanly.',
      receipts: ['selector ok', 'drafter ok'],
      media_request: null,
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));
    const windowsJson = [
      {
        name: 'weekday-morning',
        days: ['wed'],
        start: '10:00',
        end: '11:00',
      },
    ];

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:30:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });

    const initialMessage = requireValue(telegram.sentMessages[0], 'telegram.sentMessages[0]');
    telegram.enqueueUpdates([
      createControlReplyUpdate({
        updateId: 91,
        chatId: -1001234567890,
        text: 'hold',
        replyToMessage: initialMessage,
      }),
    ]);

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:32:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });
    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson,
      now: () => atLocal('2026-04-15T10:45:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });

    const candidate = await getCandidateById(database.pool, '1');
    const storedActions = await database.pool.query<{ action: string }>(
      `
        select action
        from sp_telegram_actions
        order by id asc
      `,
    );

    expect(candidate?.status).toBe('held');
    expect(storedActions.rows).toEqual([{ action: 'hold' }]);
    expect(telegram.sentPackages).toHaveLength(1);
  });

  it('keeps dry-run ticks side-effect free for due slots and pending auto-post transitions', async () => {
    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-dry-run',
        occurredAt: new Date('2026-04-15T09:55:00.000Z'),
        author: 'dylanvu',
        summary: 'Dry-run should not persist a new candidate',
      },
    ]);

    const candidatesRepository = createCandidatesRepository(database.pool);
    const existingCandidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'pending_approval',
      deadlineAt: atLocal('2026-04-15T10:45:00'),
      finalPostText: 'Existing scheduled draft',
    });
    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const syncSource = {
      name: 'seeded-events',
      sync: vi.fn(async () => []),
    };
    const runSelector = vi.fn();
    const runDrafter = vi.fn();

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson: [
        {
          name: 'weekday-morning',
          days: ['wed'],
          start: '10:00',
          end: '11:00',
        },
      ],
      now: () => atLocal('2026-04-15T10:45:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
      dryRun: true,
    });

    const candidate = await getCandidateById(database.pool, existingCandidate.id);
    const candidateCount = await database.pool.query<{ count: string }>('select count(*) from sp_post_candidates');
    const runtimeStateCount = await database.pool.query<{ count: string }>('select count(*) from sp_runtime_state');

    expect(candidate?.status).toBe('pending_approval');
    expect(candidateCount.rows[0]?.count).toBe('1');
    expect(runtimeStateCount.rows[0]?.count).toBe('0');
    expect(syncSource.sync).not.toHaveBeenCalled();
    expect(runSelector).not.toHaveBeenCalled();
    expect(runDrafter).not.toHaveBeenCalled();
    expect(telegram.sentPackages).toHaveLength(0);
  });

  it('persists candidate telegram message ids and captures reply photo batches before publish', async () => {
    await seedEvents(database.pool, [
      {
        source: 'github',
        sourceId: 'github-photo-capture',
        occurredAt: new Date('2026-04-15T10:10:00.000Z'),
        author: 'dylanvu',
        summary: 'Fresh GitHub activity for photo capture',
      },
    ]);

    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const syncSource = {
      name: 'seeded-events',
      sync: vi.fn(async () => []),
    };
    const runSelector = vi.fn(async () => ({
      decision: 'select' as const,
      candidate_type: 'ship_update',
      angle: 'Photo capture test',
      why_interesting: 'Need a reply-target message id before publish.',
      source_event_ids: [1],
      artifact_ids: [],
      primary_anchor: 'anchor',
      supporting_points: ['point'],
      quote_target: null,
      suggested_media_kind: 'image',
      suggested_media_request: 'send a screenshot',
    }));
    const runDrafter = vi.fn(async () => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: 'Draft that should accept reply photos.',
      candidate_type: 'ship_update',
      quote_target_url: null,
      why_chosen: 'Need a pending candidate for media capture.',
      receipts: ['selector ok'],
      media_request: 'send a screenshot',
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson: [
        {
          name: 'weekday-morning',
          days: ['wed'],
          start: '10:00',
          end: '11:00',
        },
      ],
      now: () => atLocal('2026-04-15T10:30:00'),
      randomFractionForSlot: () => 0.5,
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });

    const initialMessage = requireValue(telegram.sentMessages[0], 'telegram.sentMessages[0]');
    const draftedCandidate = await getCandidateById(database.pool, '1');

    expect(draftedCandidate?.status).toBe('pending_approval');
    expect(draftedCandidate?.telegramMessageId).toBe(String(initialMessage.message_id));

    const candidatesRepository = createCandidatesRepository(database.pool);
    const lateCandidate = await candidatesRepository.createCandidate({
      triggerType: 'manual',
      candidateType: 'ship_update',
      status: 'post_requested',
      finalPostText: 'Already past the publish boundary',
      telegramMessageId: '9001',
    });

    telegram.enqueueUpdates([
      createPhotoReplyUpdate({
        updateId: 101,
        chatId: -1001234567890,
        messageId: 901,
        replyMessageId: initialMessage.message_id,
        mediaGroupId: 'album-1',
        photoIds: [
          { fileId: 'small', fileUniqueId: 'photo-1', width: 320, height: 180 },
          { fileId: 'large', fileUniqueId: 'photo-1', width: 1280, height: 720 },
        ],
      }),
      createPhotoReplyUpdate({
        updateId: 102,
        chatId: -1001234567890,
        messageId: 902,
        replyMessageId: 9001,
        photoIds: [
          { fileId: 'ignored', fileUniqueId: 'photo-2', width: 1440, height: 900 },
        ],
      }),
    ]);

    await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson: [],
      now: () => atLocal('2026-04-15T10:32:00'),
      syncSources: [syncSource],
      runSelector,
      runDrafter,
    });

    const capturedCandidate = await getCandidateById(database.pool, '1');
    const ignoredCandidate = await getCandidateById(database.pool, lateCandidate.id);

    expect(capturedCandidate?.mediaBatchJson).toEqual({
      kind: 'telegram_photo_batch',
      replyMessageId: initialMessage.message_id,
      mediaGroupId: 'album-1',
      capturedAt: '2026-04-15T14:32:00.000Z',
      photos: [
        { fileId: 'large', fileUniqueId: 'photo-1', width: 1280, height: 720 },
      ],
    });
    expect(ignoredCandidate?.mediaBatchJson).toBeNull();
  });

  it('publishes immediately when a post-now reply transitions a candidate to post_requested', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const publishToX = vi.fn(async () => ({
      tweetId: '1900000000000000101',
      url: 'https://x.com/bicep_pump/status/1900000000000000101',
      raw: { ok: true, tweetId: '1900000000000000101' },
    }));
    const candidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'pending_approval',
      deadlineAt: atLocal('2026-04-15T10:45:00'),
      finalPostText: 'Publish this immediately.',
      telegramMessageId: '8000',
    });

    telegram.enqueueUpdates([
      createControlReplyUpdate({
        updateId: 150,
        chatId: -1001234567890,
        text: 'post now',
        replyToMessage: {
          message_id: 8000,
          chat: {
            id: -1001234567890,
            type: 'private',
          },
          text: `Candidate #${candidate.id}\nDraft:\nPublish this immediately.`,
        },
      }),
    ]);

    const result = await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson: [],
      now: () => atLocal('2026-04-15T10:31:00'),
      syncSources: [],
      postProfile: 'bicep_pump',
      clawdTweetScript: '/srv/clawd/scripts/tweet.js',
      publishToX,
    });

    const candidateRow = await getCandidateById(database.pool, candidate.id);
    const publishedPosts = await database.pool.query<{ count: string }>(
      'select count(*) from sp_published_posts',
    );

    expect(result.postRequestedCandidateIds).toEqual([candidate.id]);
    expect(candidateRow?.status).toBe('published');
    expect(publishedPosts.rows[0]?.count).toBe('1');
    expect(publishToX).toHaveBeenCalledOnce();
  });

  it('publishes immediately when a pending candidate reaches its deadline', async () => {
    const candidatesRepository = createCandidatesRepository(database.pool);
    const telegram = createStubTelegramClient({ chatId: -1001234567890 });
    const publishToX = vi.fn(async () => ({
      tweetId: '1900000000000000102',
      url: 'https://x.com/bicep_pump/status/1900000000000000102',
      raw: { ok: true, tweetId: '1900000000000000102' },
    }));
    const candidate = await candidatesRepository.createCandidate({
      triggerType: 'scheduled',
      candidateType: 'ship_update',
      status: 'pending_approval',
      deadlineAt: atLocal('2026-04-15T10:30:00'),
      finalPostText: 'Deadline reached publish.',
    });

    const result = await runTick({
      db: database.pool,
      telegramClient: telegram.client,
      controlChatId: '-1001234567890',
      windowsJson: [],
      now: () => atLocal('2026-04-15T10:30:00'),
      syncSources: [],
      postProfile: 'bicep_pump',
      clawdTweetScript: '/srv/clawd/scripts/tweet.js',
      publishToX,
    });

    const candidateRow = await getCandidateById(database.pool, candidate.id);
    const publishedPosts = await database.pool.query<{ count: string }>(
      'select count(*) from sp_published_posts',
    );

    expect(result.postRequestedCandidateIds).toEqual([candidate.id]);
    expect(candidateRow?.status).toBe('published');
    expect(publishedPosts.rows[0]?.count).toBe('1');
    expect(publishToX).toHaveBeenCalledOnce();
  });
});
