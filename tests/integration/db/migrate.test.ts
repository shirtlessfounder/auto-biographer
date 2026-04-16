import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/db/migrate';
import { createPool } from '../../../src/db/pool';

const execFileAsync = promisify(execFile);

type TestDatabase = {
  dataDirectory: string;
  logFilePath: string;
  pool: Pool;
  port: number;
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
  const baseDirectory = await mkdtemp(path.join(tmpdir(), 'auto-biographer-migrate-'));
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
    logFilePath,
    pool,
    port,
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

async function createFixtureMigrationsDirectory(): Promise<string> {
  const migrationsDirectory = await mkdtemp(path.join(tmpdir(), 'auto-biographer-migrations-'));

  await writeFile(
    path.join(migrationsDirectory, '0001_create_test_table.sql'),
    `
      create table if not exists migration_test_log (
        version text primary key
      );
    `,
  );
  await writeFile(
    path.join(migrationsDirectory, '0002_insert_test_row.sql'),
    `
      insert into migration_test_log (version)
      values ('0002_insert_test_row.sql');
    `,
  );

  return migrationsDirectory;
}

describe('runMigrations', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  beforeEach(async () => {
    await resetSchema(database.pool);
  });

  afterAll(async () => {
    if (database) {
      await stopTestDatabase(database);
    }
  });

  it('applies sql files in lexical order once', async () => {
    const migrationsDirectory = await createFixtureMigrationsDirectory();

    try {
      const firstRun = await runMigrations(database.pool, { migrationsDirectory });
      const secondRun = await runMigrations(database.pool, { migrationsDirectory });
      const result = await database.pool.query<{ version: string }>(`
        select version
        from schema_migrations
        order by version asc
      `);
      const inserted = await database.pool.query<{ version: string }>(`
        select version
        from migration_test_log
      `);

      expect(firstRun).toEqual(['0001_create_test_table.sql', '0002_insert_test_row.sql']);
      expect(secondRun).toEqual([]);
      expect(result.rows.map((row) => row.version)).toEqual(firstRun);
      expect(inserted.rows).toEqual([{ version: '0002_insert_test_row.sql' }]);
    } finally {
      await rm(migrationsDirectory, { force: true, recursive: true });
    }
  });

  it('creates the initial auto-biographer tables', async () => {
    await runMigrations(database.pool);

    const result = await database.pool.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name like 'sp_%'
      order by table_name asc
    `);
    const candidateColumns = await database.pool.query<{
      column_name: string;
      data_type: string;
    }>(`
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'sp_post_candidates'
      order by column_name asc
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([
      'sp_artifacts',
      'sp_candidate_control_messages',
      'sp_candidate_sources',
      'sp_events',
      'sp_post_candidates',
      'sp_published_posts',
      'sp_runtime_state',
      'sp_source_usage',
      'sp_telegram_actions',
    ]);
    expect(candidateColumns.rows).toEqual(
      expect.arrayContaining([
        { column_name: 'media_batch_json', data_type: 'jsonb' },
        { column_name: 'telegram_message_id', data_type: 'bigint' },
      ]),
    );
  });

  it('records 0004 when schema objects already exist', async () => {
    await runMigrations(database.pool, {
      migrationsDirectory: path.join(process.cwd(), 'src/db/migrations'),
    });
    await database.pool.query(`
      delete from schema_migrations
      where version = '0004_candidate_control_messages.sql'
    `);

    const rerun = await runMigrations(database.pool, {
      migrationsDirectory: path.join(process.cwd(), 'src/db/migrations'),
    });
    const recorded = await database.pool.query<{ version: string }>(`
      select version
      from schema_migrations
      where version = '0004_candidate_control_messages.sql'
    `);

    expect(rerun).toEqual(['0004_candidate_control_messages.sql']);
    expect(recorded.rows).toEqual([{ version: '0004_candidate_control_messages.sql' }]);
  });
});
