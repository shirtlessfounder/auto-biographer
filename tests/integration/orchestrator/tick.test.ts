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
import { createPublishedPostsRepository } from '../../../src/db/repositories/published-posts-repository';
import { upsertEvents } from '../../../src/normalization/upsert-events';
import { buildRecentContextPacket } from '../../../src/orchestrator/context-builder';
import { draftSelectedCandidate } from '../../../src/orchestrator/draft-candidate';
import { selectCandidate } from '../../../src/orchestrator/select-candidate';
import type { NormalizedEventInput } from '../../../src/normalization/types';
import type { XThreadLookupClient } from '../../../src/enrichment/x/client';

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
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'social-posting-orchestrator-'));
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

  it('builds one recent context packet from the last 12 hours, excludes used sources, and includes recent published posts', async () => {
    const now = new Date('2026-04-15T12:00:00.000Z');
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
        title: 'social-posting push',
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
        occurredAt: new Date('2026-04-14T23:59:00.000Z'),
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

    expect(context.windowStart).toBe('2026-04-15T00:00:00.000Z');
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

  it('persists selected candidate-source links without duplicates and returns one Telegram-ready package after drafting', async () => {
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
        title: 'social-posting push',
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
      quote_target: null,
      suggested_media_kind: null,
      suggested_media_request: null,
    }));
    const selected = await selectCandidate({
      db: database.pool,
      context,
      triggerType: 'scheduled',
      runSelector,
      xLookupClient: createXLookupClient(),
    });

    expect(selected.outcome).toBe('select');
    if (selected.outcome !== 'select') {
      throw new Error('Expected a selected candidate');
    }

    expect(selected.selectedPacket.quoteTargetEnrichment).toMatchObject({
      canonicalUrl: 'https://x.com/dylanvu/status/1234567890123456789',
      tweetId: '1234567890123456789',
    });

    const runDrafter = vi.fn(async (input: typeof selected.selectedPacket) => ({
      decision: 'success' as const,
      delivery_kind: 'single_post' as const,
      draft_text: `Built the first semiautonomous X orchestrator layer. ${input.selection.primaryAnchor}`,
      candidate_type: input.selection.candidateType,
      quote_target_url: input.quoteTargetEnrichment?.canonicalUrl ?? null,
      why_chosen: 'It is concrete, recent, and grounded in real work.',
      receipts: ['Context packet built', 'Selector persisted', 'Telegram package ready'],
      media_request: 'screenshot of the new integration test passing',
      allowed_commands: ['skip', 'hold', 'post now', 'edit: ...', 'another angle'],
    }));
    const drafted = await draftSelectedCandidate({
      db: database.pool,
      selected,
      runDrafter,
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
        quoteTargetUrl: 'https://x.com/dylanvu/status/1234567890123456789',
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
        quote_target_url: 'https://x.com/dylanvu/status/1234567890123456789',
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
});
