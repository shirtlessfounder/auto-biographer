import { fileURLToPath } from 'node:url';

import { loadEnv } from './config/env';
import { runMigrations } from './db/migrate';
import { createPool } from './db/pool';

async function runMigrateCommand(): Promise<void> {
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

function runCheckEnvCommand(): void {
  const env = loadEnv(process.env);

  process.stdout.write(
    `${JSON.stringify({
      postProfile: env.postProfile,
      slackAuthorNames: env.slackAuthorNames,
      slackAuthorUserIds: env.slackAuthorUserIds,
      windowsCount: env.windowsJson.length,
    })}\n`,
  );
}

function printUsage(): void {
  process.stderr.write('Usage: pnpm cli -- <migrate|check-env>\n');
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];

  switch (command) {
    case 'migrate':
      await runMigrateCommand();
      return;
    case 'check-env':
      runCheckEnvCommand();
      return;
    default:
      printUsage();
      throw new Error(`Unknown command: ${command ?? '(missing)'}`);
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
