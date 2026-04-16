import { fileURLToPath } from 'node:url';

import { loadEnv } from '../config/env';
import { createPool } from '../db/pool';
import { createXClient } from '../enrichment/x/client';
import { runOnDemandDraft, type SharedDraftPipelineInput } from '../orchestrator/tick';
import { createHermesBackedTelegramClient } from '../telegram/hermes-client';
import { buildSyncSources } from './tick';

export async function runDraftNow(
  input: Omit<SharedDraftPipelineInput, 'triggerType' | 'deadlineAt'>,
): Promise<{ candidateId: string | null }> {
  return runOnDemandDraft(input);
}

export async function runDraftNowCommand(argv: string[] = process.argv.slice(2)): Promise<{ candidateId: string | null }> {
  if (argv.length > 0) {
    throw new Error(`Unsupported draft-now arguments: ${argv.join(', ')}`);
  }

  const env = loadEnv(process.env);
  const pool = createPool(env.databaseUrl);
  const telegramClient = createHermesBackedTelegramClient({
    botToken: env.telegramControlBotToken,
    chatId: env.telegramControlChatId,
    hermesAgentDir: env.hermesAgentDir,
  });
  const xLookupClient = createXClient({
    bearerToken: env.xBearerToken,
  });

  try {
    const result = await runDraftNow({
      db: pool,
      telegramClient,
      syncSources: buildSyncSources({ db: pool, env }),
      hermesBin: env.hermesBin,
      xLookupClient,
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
  runDraftNowCommand().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
