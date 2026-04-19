import { fileURLToPath } from 'node:url';

import { loadEnv, type AppEnv } from '../config/env';
import { getPool } from '../db/mcp-client';
import { createXClient } from '../enrichment/x/client';
import { runTick, type RunTickResult, type SyncSource } from '../orchestrator/tick';
import { createGitHubSource } from '../sources/github-source';
import { createInniesSource } from '../sources/innies-source';
import { createSlackLinksSource } from '../sources/slack-links-source';
import { createSlackMessagesSource } from '../sources/slack-messages-source';
import { createTelegramClient } from '../telegram/client';
import { loadOAuthEnv } from '../config/oauth-env';

const SOURCE_SYNC_LOOKBACK_HOURS = 16;

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
          apiKey: input.env.inniesApiKey ?? '',
          buyerKeyId: input.env.inniesBuyerKeyId ?? '',
          buyerKeyName: input.env.inniesBuyerKeyName,
          lookbackHours: SOURCE_SYNC_LOOKBACK_HOURS,
        }).sync(),
    },
    {
      name: 'github',
      sync: () =>
        createGitHubSource(input.db, {
          githubUsername: input.env.githubUsername,
          lookbackHours: SOURCE_SYNC_LOOKBACK_HOURS,
        }).sync(),
    },
  ];
}

function parseTickArgs(argv: string[]): { dryRun: boolean; skipTelegram: boolean } {
  const unsupported = argv.filter((argument) => argument !== '--dry-run' && argument !== '--no-telegram');

  if (unsupported.length > 0) {
    throw new Error(`Unsupported tick arguments: ${unsupported.join(', ')}`);
  }

  return {
    dryRun: argv.includes('--dry-run'),
    skipTelegram: argv.includes('--no-telegram'),
  };
}

export async function runTickCommand(argv: string[] = process.argv.slice(2)): Promise<RunTickResult> {
  const env = loadEnv(process.env);
  const args = parseTickArgs(argv);
  const pool = await getPool();
  const telegramClient = createTelegramClient({
    botToken: env.telegramControlBotToken,
    chatId: env.telegramControlChatId,
    apiBaseUrl: env.telegramApiBaseUrl,
  });
  const xLookupClient = createXClient({
    baseUrl: 'https://x-trapezius.int.exe.xyz/2',
  });
  const oauthEnv = loadOAuthEnv(process.env);
  const xApiBaseUrl = process.env.X_API_BASE_URL ?? 'https://x-trapezius.int.exe.xyz/2';
  const oauthCredentials = {
    consumerKey: oauthEnv.X_CONSUMER_KEY,
    consumerSecret: oauthEnv.X_CONSUMER_SECRET,
    accessToken: oauthEnv.X_ACCESS_TOKEN,
    accessTokenSecret: oauthEnv.X_ACCESS_TOKEN_SECRET,
  };

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
      oauthCredentials,
      xApiBaseUrl,
      dryRun: args.dryRun,
      skipTelegram: args.skipTelegram,
      publishGraceMinutes: env.publishGraceMinutes,
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
