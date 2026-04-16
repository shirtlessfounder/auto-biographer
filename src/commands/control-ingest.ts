import { fileURLToPath } from 'node:url';

import { loadEnv } from '../config/env';
import { createPool } from '../db/pool';
import {
  ingestDraftControlPhotoReply,
  ingestDraftControlTextReply,
} from '../control/ingest';
import type { TelegramPhotoBatchPhoto } from '../telegram/photo-batches';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString('utf8').trim();
}

type ControlIngestPayload =
  | {
      kind: 'text_reply';
      telegramUpdateId: string;
      telegramMessageId: string;
      actorUserId: string | null;
      replyToTelegramMessageId: string;
      text: string;
    }
  | {
      kind: 'photo_reply';
      telegramUpdateId: string;
      telegramMessageId: string;
      actorUserId: string | null;
      replyToTelegramMessageId: string;
      mediaGroupId: string | null;
      photos: TelegramPhotoBatchPhoto[];
    };

function parsePayload(raw: string): ControlIngestPayload {
  const parsed = JSON.parse(raw) as ControlIngestPayload;

  if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
    throw new Error('control-ingest payload must be a JSON object with a kind field');
  }

  return parsed;
}

export async function runControlIngestCommand(
  argv: string[] = process.argv.slice(2),
): Promise<{ result: string; candidateId: string | null; action?: string | null }> {
  if (argv.length > 0) {
    throw new Error(`Unsupported control-ingest arguments: ${argv.join(', ')}`);
  }

  const rawPayload = await readStdin();

  if (!rawPayload) {
    throw new Error('control-ingest expects a JSON payload on stdin');
  }

  const payload = parsePayload(rawPayload);
  const env = loadEnv(process.env);
  const pool = createPool(env.databaseUrl);

  try {
    const result = payload.kind === 'text_reply'
      ? await ingestDraftControlTextReply({
          db: pool,
          telegramUpdateId: payload.telegramUpdateId,
          telegramMessageId: payload.telegramMessageId,
          actorUserId: payload.actorUserId,
          replyToTelegramMessageId: payload.replyToTelegramMessageId,
          text: payload.text,
        })
      : await ingestDraftControlPhotoReply({
          db: pool,
          telegramUpdateId: payload.telegramUpdateId,
          telegramMessageId: payload.telegramMessageId,
          actorUserId: payload.actorUserId,
          replyToTelegramMessageId: payload.replyToTelegramMessageId,
          mediaGroupId: payload.mediaGroupId,
          photos: payload.photos,
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
  runControlIngestCommand().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
