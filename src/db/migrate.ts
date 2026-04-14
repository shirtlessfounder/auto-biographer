import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { createPool } from './pool';
import { createMigrationsRepository } from './repositories/migrations-repository';

const defaultMigrationsDirectory = fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(
  pool: Pool,
  options?: { migrationsDirectory?: string },
): Promise<string[]> {
  const migrationsDirectory = options?.migrationsDirectory ?? defaultMigrationsDirectory;
  const migrationsRepository = createMigrationsRepository(pool);

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
    const client = await pool.connect();

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
  }

  return appliedThisRun;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = createPool(databaseUrl);

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
