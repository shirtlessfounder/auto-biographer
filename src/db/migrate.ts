import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool } from './mcp-client';
import type { Queryable } from './pool';
import { createMigrationsRepository } from './repositories/migrations-repository';

const defaultMigrationsDirectory = fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(
  db: Queryable,
  options?: { migrationsDirectory?: string },
): Promise<string[]> {
  const migrationsDirectory = options?.migrationsDirectory ?? defaultMigrationsDirectory;
  const migrationsRepository = createMigrationsRepository(db);

  await migrationsRepository.ensureSchemaMigrationsTable();

  const appliedVersions = new Set(await migrationsRepository.listAppliedMigrations());
  const files = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));
  const appliedThisRun: string[] = [];

  for (const fileName of files) {
    if (appliedVersions.has(fileName)) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDirectory, fileName), 'utf8');

    // Support both pg Pool (with connect/begin/commit/rollback) and
    // our MCP TransactionConnection (with begin/commit/rollback/release)
    if ('connect' in db && typeof db.connect === 'function') {
      // pg Pool — use transaction connection
      const client = await db.connect();
      try {
        await client.query('begin');
        await client.query(sql);
        const repository = createMigrationsRepository(client);
        await repository.recordAppliedMigration(fileName);
        await client.query('commit');
        appliedThisRun.push(fileName);
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    } else {
      // Queryable without transactions — run bare (migrate.ts entry point
      // always uses McpPool which has connect())
      throw new Error('migrate.ts requires a Pool with transaction support');
    }
  }

  return appliedThisRun;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = await getPool();

  try {
    const appliedMigrations = await runMigrations(pool);

    process.stdout.write(`${JSON.stringify({ appliedMigrations })}\n`);
  } finally {
    await pool.end();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
