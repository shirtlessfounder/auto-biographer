import { fileURLToPath } from 'node:url';

import { loadEnv, type AppEnv } from '../config/env';
import { createPool } from '../db/pool';
import { createXClient } from '../enrichment/x/client';
import { runTick, type RunTickResult, type SyncSource } from '../orchestrator/tick';
import { createGitHubSource } from '../sources/github-source';
import { createInniesSource } from '../sources/innies-source';
import { createSlackLinksSource } from '../sources/slack-links-source';
import { createSlackMessagesSource } from '../sources/slack-messages-source';
import { createTelegramClient } from '../telegram/client';

const SOURCE_SYNC_LOOKBACK_HOURS = 12;

function buildSyncSources(input: {
  db: Parameters<typeof createGitHubSource>[0];
  env: AppEnv;
}): SyncSource[] {
  return [
    {
      name: 'slack_messages',
      sync: () =>
        createSlackMessagesSource(input.db, {
          authorNames: input.env.slackAuthorNames,
          authorUserIds: input.env.slackAuthorUserIds,
          lookbackHours: SOURCE_SYNC_LOOKBACK_HOURS,
        }).sync(),
    },
    {
      name: 'slack_links',
      sync: () =>
        createSlackLinksSource(input.db, {
          authorNames: input.env.slackAuthorNames,
          authorUserIds: input.env.slackAuthorUserIds,
          lookbackHours: SOURCE_SYNC_LOOKBACK_HOURS,
        }).sync(),
    },
    {
      name: 'innies',
      sync: () =>
        createInniesSource(input.db, {
          buyerKeyName: input.env.inniesBuyerKeyName,
          lookbackHours: SOURCE_SYNC_LOOKBACK_HOURS,
        }).sync(),
    },
    {
      name: 'github',
      sync: () =>
        createGitHubSource(input.db, {
          githubUsername: input.env.githubUsername,
        }).sync(),
    },
  ];
}

function parseTickArgs(argv: string[]): { dryRun: boolean } {
  const unsupported = argv.filter((argument) => argument !== '--dry-run');

  if (unsupported.length > 0) {
    throw new Error(`Unsupported tick arguments: ${unsupported.join(', ')}`);
  }

  return {
    dryRun: argv.includes('--dry-run'),
  };
}

export async function runTickCommand(argv: string[] = process.argv.slice(2)): Promise<RunTickResult> {
  const env = loadEnv(process.env);
  const args = parseTickArgs(argv);
  const pool = createPool(env.databaseUrl);
  const telegramClient = createTelegramClient({
    botToken: env.telegramControlBotToken,
    chatId: env.telegramControlChatId,
  });
  const xLookupClient = createXClient({
    bearerToken: env.xBearerToken,
  });

  try {
    const result = await runTick({
      db: pool,
      telegramClient,
      controlChatId: env.telegramControlChatId,
      windowsJson: env.windowsJson,
      syncSources: buildSyncSources({ db: pool, env }),
      hermesBin: env.hermesBin,
      xLookupClient,
      postProfile: env.postProfile,
      clawdTweetScript: env.clawdTweetScript,
      dryRun: args.dryRun,
    });

    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await pool.end();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  runTickCommand().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { buildSyncSources };
