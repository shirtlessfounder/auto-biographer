import { fileURLToPath } from 'node:url';

import { loadEnv } from '../config/env';
import { getPool } from '../db/mcp-client';
import { applyCandidateAction } from '../orchestrator/state-machine';
import type { TelegramControlAction } from '../telegram/command-parser';

const VALID_ACTIONS: readonly TelegramControlAction[] = [
  'skip',
  'post_now',
  'edit',
  'another_angle',
];

type ApplyCommandArgs = {
  candidateId: string;
  action: TelegramControlAction;
  payload: string | null;
};

function parseArgs(argv: string[]): ApplyCommandArgs {
  let candidateId: string | null = null;
  let action: string | null = null;
  let payload: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--candidate') {
      candidateId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--action') {
      action = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--payload') {
      payload = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    throw new Error(`Unsupported apply-command argument: ${String(argument)}`);
  }

  if (!candidateId || !/^\d+$/.test(candidateId)) {
    throw new Error('--candidate <id> is required and must be numeric');
  }

  if (!action || !VALID_ACTIONS.includes(action as TelegramControlAction)) {
    throw new Error(
      `--action is required and must be one of: ${VALID_ACTIONS.join(', ')}`,
    );
  }

  if (action === 'edit' && (payload === null || payload.trim().length === 0)) {
    throw new Error('edit action requires --payload "<new text>"');
  }

  return {
    candidateId,
    action: action as TelegramControlAction,
    payload,
  };
}

export async function runApplyCommand(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);
  const env = loadEnv(process.env);
  const pool = await getPool();

  try {
    const result = await applyCandidateAction({
      db: pool,
      candidateId: args.candidateId,
      action: args.action,
      payload: args.payload,
      publishGraceMinutes: env.publishGraceMinutes,
    });

    if (!result.applied || !result.candidate) {
      throw new Error(
        `Candidate ${args.candidateId} is not in an allowed state for action ${args.action}`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        candidateId: result.candidate.id,
        status: result.candidate.status,
        publishAt: result.candidate.publishAt,
        finalPostText: result.candidate.finalPostText,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  runApplyCommand().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
