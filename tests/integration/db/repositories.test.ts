/**
 * Integration tests for database repositories.
 *
 * Uses an in-memory mock pool (no pg binary required) to test repository logic
 * against a simulated database layer. The mock intercepts SQL via pattern-matched
 * mocks, enabling full integration testing of repository code without a live Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── In-memory SQL engine ──────────────────────────────────────────────────────

type SqlValue = string | number | boolean | null;
type Row = Record<string, SqlValue>;

interface Table {
  columns: string[];
  rows: Row[];
}

interface MockEntry {
  pattern: RegExp;
  result: Row[] | ((sql: string, params?: SqlValue[]) => Row[]);
}

class InMemoryEngine {
  private tables = new Map<string, Table>();
  private migrations: string[] = [];

  reset(): void {
    this.tables.clear();
    this.migrations = [];
  }

  reapplyMigrations(): void {
    for (const sql of this.migrations) {
      this.executeRaw(sql, []);
    }
  }

  getTable(name: string): Table | undefined {
    return this.tables.get(name.toLowerCase());
  }

  executeRaw(sql: string, params: SqlValue[]): { rows: Row[]; rowCount: number } {
    const t = sql.trimStart().toLowerCase();

    // CREATE TABLE
    if (t.startsWith('create table')) {
      const match = sql.match(/create table\s*(?:if not exists\s+)?(\w+)\s*\(([^)]+)\)/i);
      if (match) {
        const tbl = match[1].toLowerCase();
        const colDefs = match[2];
        const cols = colDefs
          .split(',')
          .map((c) => c.trim().split(/\s+/)[0].replace(/["']/g, ''))
          .filter(Boolean);
        this.tables.set(tbl, { columns: cols as string[], rows: [] });
        return { rows: [], rowCount: 0 };
      }
    }

    if (t.startsWith('create index') || t.startsWith('create unique index')) {
      return { rows: [], rowCount: 0 };
    }

    if (t.startsWith('alter table')) {
      return { rows: [], rowCount: 0 };
    }

    // INSERT
    if (t.startsWith('insert')) {
      const intoMatch = sql.match(/insert\s+into\s+(\w+)/i);
      if (intoMatch) {
        const tbl = intoMatch[1].toLowerCase();
        const returningMatch = sql.match(/returning\s+(\w+)/i);
        const valsMatch = sql.match(/values\s*(.+?)(?:\s+returning\s+|$)/is);

        let table = this.tables.get(tbl);
        if (!table) {
          // Infer from migration
          const mig = this.migrations.find((m) => m.toLowerCase().includes(`create table ${tbl}`));
          if (mig) {
            const cm = mig.match(/create table.*?\(([^)]+)\)/i);
            if (cm) {
              const cols = cm[1].split(',').map((c) => c.trim().split(/\s+/)[0].replace(/["']/g, ''));
              table = { columns: cols as string[], rows: [] };
              this.tables.set(tbl, table);
            }
          } else {
            return { rows: [], rowCount: 0 };
          }
        }

        if (valsMatch) {
          const raw = valsMatch[1];
          // Replace $N with params
          let idx = 0;
          const resolved = raw.replace(/\$(\d+)/g, () => String(params[idx++] ?? null));
          // Find all tuple groups
          const tupleRe = /\(([^)]*)\)/g;
          let m;
          while ((m = tupleRe.exec(resolved)) !== null) {
            const vals = this.parseRow(m[1]);
            const row: Row = {};
            table.columns.forEach((col, i) => {
              row[col] = vals[i] ?? null;
            });
            // Auto-assign serial id
            if (table.columns.includes('id') && row['id'] == null) {
              const ids = table.rows
                .map((r) => parseInt(String(r['id'])))
                .filter((n) => !isNaN(n));
              row['id'] = String(ids.length > 0 ? Math.max(...ids) + 1 : 1);
            }
            table.rows.push(row);
          }
        }

        if (returningMatch) {
          const lastRow = table.rows[table.rows.length - 1];
          const retCol = returningMatch[1].toLowerCase();
          return { rows: [{ [retCol]: lastRow?.[retCol] ?? null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    }

    // UPDATE
    if (t.startsWith('update')) {
      const match = sql.match(/update\s+(\w+)\s+set\s+(.+?)(?:\s+where\s+(.+))?$/is);
      if (match) {
        const tbl = match[1].toLowerCase();
        const setStr = match[2];
        const whereStr = match[3] ?? '';
        const table = this.tables.get(tbl);
        if (!table) return { rows: [], rowCount: 0 };

        const setPairs: [string, string][] = setStr.split(',').map((s) => {
          const [col, ...rest] = s.trim().split('=');
          return [col.trim().toLowerCase(), rest.join('=').trim()];
        });

        let pidx = 0;
        const getVal = (expr: string): SqlValue => {
          const e = expr.trim();
          if (e.startsWith('$')) return params[parseInt(e.slice(1)) - 1] ?? null;
          return this.parseScalar(e);
        };

        let count = 0;
        for (const row of table.rows) {
          if (whereStr && !this.evalWhere(row, whereStr, params)) continue;
          for (const [col, valExpr] of setPairs) {
            row[col] = getVal(valExpr);
          }
          count++;
        }
        return { rows: [], rowCount: count };
      }
    }

    // DELETE
    if (t.startsWith('delete')) {
      const match = sql.match(/delete\s+from\s+(\w+)(?:\s+where\s+(.+))?$/is);
      if (match) {
        const tbl = match[1].toLowerCase();
        const whereStr = match[2] ?? '';
        const table = this.tables.get(tbl);
        if (!table) return { rows: [], rowCount: 0 };

        const before = table.rows.length;
        if (whereStr) {
          table.rows = table.rows.filter((r) => !this.evalWhere(r, whereStr, params));
        } else {
          table.rows = [];
        }
        return { rows: [], rowCount: before - table.rows.length };
      }
    }

    // SELECT
    if (t.startsWith('select')) {
      // Count
      const cntMatch = sql.match(/select\s+count\(\*\)\s+(?:as\s+\w+\s+)?from\s+(\w+)(?:\s+where\s+(.+?))?(?:\s+order\s+by|\s+limit|\s+group\s+by|$)/is);
      if (cntMatch) {
        const tbl = cntMatch[1].toLowerCase();
        const whereStr = cntMatch[2] ?? '';
        const table = this.tables.get(tbl);
        if (!table) return { rows: [{ count: '0' }], rowCount: 1 };
        let rows = table.rows;
        if (whereStr) rows = rows.filter((r) => this.evalWhere(r, whereStr, params));
        return { rows: [{ count: String(rows.length) }], rowCount: 1 };
      }

      const fromMatch = sql.match(/from\s+(\w+)/i);
      if (fromMatch) {
        const tbl = fromMatch[1].toLowerCase();
        const table = this.tables.get(tbl);
        if (!table) return { rows: [], rowCount: 0 };

        let rows = [...table.rows];

        const whereMatch = sql.match(/where\s+(.+?)(?:\s+order\s+by|\s+limit|\s+group\s+by|$)/is);
        if (whereMatch) rows = rows.filter((r) => this.evalWhere(r, whereMatch[1], params));

        const orderMatch = sql.match(/order\s+by\s+(.+?)(?:\s+limit|$)/is);
        if (orderMatch) {
          const col = orderMatch[1].split(/\s+/)[0].toLowerCase();
          rows.sort((a, b) => {
            const av = a[col];
            const bv = b[col];
            if (av == null) return 1;
            if (bv == null) return -1;
            if (typeof av === 'number' && typeof bv === 'number') return av - bv;
            return String(av).localeCompare(String(bv));
          });
        }

        const limitMatch = sql.match(/limit\s+(\d+)/i);
        if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1]));

        return { rows, rowCount: rows.length };
      }
    }

    // BEGIN/COMMIT/ROLLBACK — noop
    if (['begin', 'begin;', 'commit', 'commit;', 'rollback', 'rollback;', 'select 1'].includes(t)) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  private parseRow(s: string): SqlValue[] {
    const result: SqlValue[] = [];
    let cur = '';
    let inStr = false;
    let strChar = '';
    let depth = 0;

    for (const ch of s) {
      if (!inStr && (ch === "'" || ch === '"')) {
        inStr = true;
        strChar = ch;
        cur += ch;
      } else if (inStr && ch === strChar) {
        inStr = false;
        cur += ch;
      } else if (!inStr && ch === '(') {
        depth++;
        cur += ch;
      } else if (!inStr && ch === ')') {
        depth--;
        cur += ch;
      } else if (!inStr && ch === ',') {
        if (depth === 0) {
          result.push(this.parseScalar(cur.trim()));
          cur = '';
        } else {
          cur += ch;
        }
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) result.push(this.parseScalar(cur.trim()));
    return result;
  }

  private parseScalar(s: string): SqlValue {
    const t = s.trim();
    if (t === 'null' || t === 'NULL') return null;
    if (t === 'true' || t === 'TRUE') return true;
    if (t === 'false' || t === 'FALSE') return false;
    if (/^-?\d+$/.test(t)) return Number(t);
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      return t.slice(1, -1);
    }
    return t;
  }

  private evalWhere(row: Row, clause: string, params: SqlValue[]): boolean {
    const conds = clause.split(/\s+and\s+/i);
    for (const cond of conds) {
      const eq = cond.match(/^(\w+)\s*=\s*(.+)$/i);
      if (eq) {
        const col = eq[1].toLowerCase();
        const rhs = eq[2].trim();
        const val: SqlValue = rhs.startsWith('$') ? params[parseInt(rhs.slice(1)) - 1] ?? null : this.parseScalar(rhs);
        if (row[col] !== val) return false;
        continue;
      }
      const nl = cond.match(/^(\w+)\s+is\s+null$/i);
      if (nl) {
        if (row[nl[1].toLowerCase()] != null) return false;
        continue;
      }
      const lk = cond.match(/^(\w+)\s+like\s+(.+)$/i);
      if (lk) {
        const col = lk[1].toLowerCase();
        const pat = String(this.parseScalar(lk[2])).replace(/%/g, '.*');
        if (!new RegExp(`^${pat}$`, 'i').test(String(row[col] ?? ''))) return false;
        continue;
      }
    }
    return true;
  }

  addMigration(sql: string): void {
    this.migrations.push(sql);
  }

  getMigrations(): string[] {
    return [...this.migrations];
  }
}

// ─── Mock pool ────────────────────────────────────────────────────────────────

export class MockPool {
  private engine: InMemoryEngine;
  private mocks: MockEntry[] = [];

  constructor(engine: InMemoryEngine) {
    this.engine = engine;
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    // Check mocks first
    for (const mock of this.mocks) {
      if (mock.pattern.test(sql)) {
        const rows = typeof mock.result === 'function' ? mock.result(sql, params as SqlValue[]) : mock.result;
        return { rows: rows as T[], rowCount: rows.length };
      }
    }

    // Track DDL
    const t = sql.trimStart().toLowerCase();
    if (
      t.startsWith('create table') ||
      t.startsWith('create index') ||
      t.startsWith('create unique index') ||
      t.startsWith('alter table')
    ) {
      this.engine.addMigration(sql);
    }

    return this.engine.executeRaw(sql, (params ?? []) as SqlValue[]) as { rows: T[]; rowCount: number };
  }

  async connect(): Promise<{
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    release(): void;
  }> {
    return {
      query: this.query.bind(this),
      begin: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    };
  }

  async end(): Promise<void> {}

  mockQuery(pattern: RegExp, result: Row[] | ((sql: string, params?: SqlValue[]) => Row[])): void {
    this.mocks.push({ pattern, result });
  }

  clearMocks(): void {
    this.mocks = [];
  }

  async resetSchema(): Promise<void> {
    this.engine.reset();
    this.engine.reapplyMigrations();
  }
}

// ─── Test database factory ───────────────────────────────────────────────────

const sharedEngine = new InMemoryEngine();
let sharedPool: MockPool;

async function createTestDatabase(): Promise<{ pool: MockPool }> {
  sharedEngine.reset();
  sharedPool = new MockPool(sharedEngine);
  return { pool: sharedPool };
}

async function stopTestDatabase(): Promise<void> {
  sharedEngine.reset();
}

// ─── Migrations ───────────────────────────────────────────────────────────────

const MIGRATIONS = [
  // sp_events
  `CREATE TABLE sp_events (
    id SERIAL PRIMARY KEY,
    source VARCHAR(50) NOT NULL,
    source_id VARCHAR(255) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    author VARCHAR(255),
    url_or_locator TEXT,
    title TEXT,
    summary TEXT,
    raw_text TEXT,
    tags TEXT[],
    raw_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(source, source_id)
  )`,
  `CREATE INDEX idx_sp_events_source ON sp_events(source)`,
  `CREATE INDEX idx_sp_events_occurred_at ON sp_events(occurred_at)`,
  // sp_artifacts
  `CREATE TABLE sp_artifacts (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES sp_events(id) ON DELETE CASCADE,
    artifact_type VARCHAR(50) NOT NULL,
    artifact_key VARCHAR(255) NOT NULL,
    content_text TEXT,
    source_url TEXT,
    raw_payload JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(event_id, artifact_key)
  )`,
  `CREATE INDEX idx_sp_artifacts_event_id ON sp_artifacts(event_id)`,
  // sp_post_candidates
  `CREATE TABLE sp_post_candidates (
    id SERIAL PRIMARY KEY,
    trigger_type VARCHAR(50) NOT NULL,
    candidate_type VARCHAR(50),
    status VARCHAR(50) NOT NULL,
    deadline_at TIMESTAMPTZ,
    selector_output_json JSONB,
    drafter_output_json JSONB,
    final_post_text TEXT,
    quote_target_url TEXT,
    media_request TEXT,
    media_batch_json JSONB,
    telegram_message_id VARCHAR(255),
    error_details TEXT,
    degraded BOOLEAN NOT NULL DEFAULT false,
    selector_skipped_at TIMESTAMPTZ,
    reminder_sent_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX idx_sp_candidates_status ON sp_post_candidates(status)`,
  `CREATE INDEX idx_sp_candidates_deadline ON sp_post_candidates(deadline_at)`,
  // sp_candidate_sources
  `CREATE TABLE sp_candidate_sources (
    id SERIAL PRIMARY KEY,
    candidate_id INTEGER NOT NULL REFERENCES sp_post_candidates(id) ON DELETE CASCADE,
    event_id INTEGER REFERENCES sp_events(id) ON DELETE SET NULL,
    artifact_id INTEGER REFERENCES sp_artifacts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX idx_sp_candidate_sources_candidate ON sp_candidate_sources(candidate_id)`,
  // sp_published_posts
  `CREATE TABLE sp_published_posts (
    id SERIAL PRIMARY KEY,
    candidate_id INTEGER NOT NULL REFERENCES sp_post_candidates(id) ON DELETE CASCADE,
    posted_at TIMESTAMPTZ NOT NULL,
    x_post_id VARCHAR(255),
    post_type VARCHAR(50) NOT NULL,
    final_text TEXT NOT NULL,
    quote_target_url TEXT,
    media_attached BOOLEAN NOT NULL DEFAULT false,
    publisher_response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // sp_runtime_state
  `CREATE TABLE sp_runtime_state (
    id SERIAL PRIMARY KEY,
    state_key VARCHAR(255) NOT NULL UNIQUE,
    state_json JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // sp_telegram_actions
  `CREATE TABLE sp_telegram_actions (
    id SERIAL PRIMARY KEY,
    candidate_id INTEGER NOT NULL REFERENCES sp_post_candidates(id) ON DELETE CASCADE,
    telegram_update_id VARCHAR(255) NOT NULL UNIQUE,
    action VARCHAR(50) NOT NULL,
    payload TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX idx_sp_telegram_actions_update ON sp_telegram_actions(telegram_update_id)`,
  // sp_source_usage
  `CREATE TABLE sp_source_usage (
    id SERIAL PRIMARY KEY,
    event_id INTEGER REFERENCES sp_events(id) ON DELETE SET NULL,
    artifact_id INTEGER REFERENCES sp_artifacts(id) ON DELETE SET NULL,
    published_post_id INTEGER REFERENCES sp_published_posts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // sp_schema_migrations
  `CREATE TABLE sp_schema_migrations (
    version VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
];

async function runMigrations(pool: MockPool): Promise<string[]> {
  await pool.resetSchema();
  const applied: string[] = [];
  for (const sql of MIGRATIONS) {
    await pool.query(sql);
    const versionMatch = sql.match(/CREATE TABLE (\w+)/i);
    if (versionMatch) {
      applied.push(versionMatch[1]);
    }
  }
  return applied;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('database repositories', () => {
  let database: { pool: MockPool };

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    await database.pool.resetSchema();
    await runMigrations(database.pool);
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  it('upserts events by source and source id', async () => {
    const { createEventsRepository } = await import('../../../src/db/repositories/events-repository');
    const eventsRepository = createEventsRepository(database.pool as unknown as import('../../../src/db/pool').Queryable);

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

  it('creates candidates, updates fields, and transitions status atomically', async () => {
    const { createCandidatesRepository } = await import('../../../src/db/repositories/candidates-repository');
    const candidatesRepository = createCandidatesRepository(database.pool as unknown as import('../../../src/db/pool').Queryable);

    const firstMediaBatch = {
      kind: 'telegram_photo_batch',
      replyMessageId: 9001,
      mediaGroupId: null,
      capturedAt: '2026-04-14T21:30:00.000Z',
      photos: [{ fileId: 'file-1', fileUniqueId: 'uniq-1', width: 1280, height: 720 }],
    };
    const nextMediaBatch = {
      kind: 'telegram_photo_batch',
      replyMessageId: 9001,
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

    const rejectedTransition = await candidatesRepository.transitionStatus({
      id: created.id,
      fromStatuses: ['drafting'],
      toStatus: 'published',
    });

    const replaced = await candidatesRepository.replaceMediaBatchByTelegramMessageId({
      telegramMessageId: '9001',
      allowedStatuses: ['pending_approval', 'reminded', 'held'],
      mediaBatchJson: nextMediaBatch,
    });

    expect(updated.finalPostText).toBe('hello world');
    expect(updated.quoteTargetUrl).toBe('https://x.com/example/status/1');
    expect(updated.telegramMessageId).toBe('9001');
    expect(updated.mediaBatchJson).toEqual(firstMediaBatch);
    expect(updated.degraded).toBe(true);
    expect(transitioned?.status).toBe('pending_approval');
    expect(transitioned?.reminderSentAt?.toISOString()).toBe('2026-04-05T12:10:00.000Z');
    expect(rejectedTransition).toBeNull();
    expect(replaced?.mediaBatchJson).toEqual(nextMediaBatch);
  });

  it('gets and sets runtime state', async () => {
    const { createRuntimeStateRepository } = await import('../../../src/db/repositories/runtime-state-repository');
    const runtimeStateRepository = createRuntimeStateRepository(database.pool as unknown as import('../../../src/db/pool').Queryable);

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
    const { createCandidatesRepository } = await import('../../../src/db/repositories/candidates-repository');
    const { createPublishedPostsRepository } = await import('../../../src/db/repositories/published-posts-repository');
    const candidatesRepository = createCandidatesRepository(database.pool as unknown as import('../../../src/db/pool').Queryable);
    const publishedPostsRepository = createPublishedPostsRepository(database.pool as unknown as import('../../../src/db/pool').Queryable);

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
    const { createCandidatesRepository } = await import('../../../src/db/repositories/candidates-repository');
    const { createTelegramActionsRepository } = await import('../../../src/db/repositories/telegram-actions-repository');
    const candidatesRepository = createCandidatesRepository(database.pool as unknown as import('../../../src/db/pool').Queryable);
    const telegramActionsRepository = createTelegramActionsRepository(database.pool as unknown as import('../../../src/db/pool').Queryable);

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
