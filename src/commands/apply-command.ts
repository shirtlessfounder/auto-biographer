import { fileURLToPath } from 'node:url';

import { loadEnv } from '../config/env';
import { createCandidatesRepository } from '../db/repositories/candidates-repository';
import { getPool } from '../db/mcp-client';
import { applyCandidateAction } from '../orchestrator/state-machine';
import type { TelegramControlAction } from '../telegram/command-parser';

const VALID_CONTROL_ACTIONS: readonly TelegramControlAction[] = [
  'skip',
  'post_now',
  'edit',
  'another_angle',
];

type AttachPhotosAction = 'attach_photos';
type CliAction = TelegramControlAction | AttachPhotosAction;

const VALID_CLI_ACTIONS: readonly CliAction[] = [
  ...VALID_CONTROL_ACTIONS,
  'attach_photos',
];

type PhotoInput = {
  fileId: string;
  fileUniqueId?: string;
  width?: number;
  height?: number;
};

type ApplyCommandArgs = {
  candidateId: string;
  action: CliAction;
  payload: string | null;
  photos: PhotoInput[] | null;
  mediaGroupId: string | null;
  replyMessageId: number | null;
};

function parsePhotosJson(value: string): PhotoInput[] {
  const parsed: unknown = JSON.parse(value);

  if (!Array.isArray(parsed)) {
    throw new Error('--photos must be a JSON array');
  }

  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`--photos[${String(index)}] must be an object`);
    }

    const record = entry as Record<string, unknown>;
    const fileId = record.fileId ?? record.file_id;

    if (typeof fileId !== 'string' || fileId.length === 0) {
      throw new Error(`--photos[${String(index)}].fileId is required`);
    }

    const fileUniqueId = record.fileUniqueId ?? record.file_unique_id;
    const width = record.width;
    const height = record.height;

    return {
      fileId,
      ...(typeof fileUniqueId === 'string' ? { fileUniqueId } : {}),
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof height === 'number' ? { height } : {}),
    };
  });
}

function parseArgs(argv: string[]): ApplyCommandArgs {
  let candidateId: string | null = null;
  let action: string | null = null;
  let payload: string | null = null;
  let photos: PhotoInput[] | null = null;
  let mediaGroupId: string | null = null;
  let replyMessageId: number | null = null;

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

    if (argument === '--photos') {
      const raw = argv[index + 1] ?? null;
      if (raw === null) {
        throw new Error('--photos requires a JSON argument');
      }
      photos = parsePhotosJson(raw);
      index += 1;
      continue;
    }

    if (argument === '--media-group-id') {
      mediaGroupId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (argument === '--reply-message-id') {
      const raw = argv[index + 1] ?? null;
      if (raw === null || !/^\d+$/.test(raw)) {
        throw new Error('--reply-message-id must be numeric');
      }
      replyMessageId = Number.parseInt(raw, 10);
      index += 1;
      continue;
    }

    throw new Error(`Unsupported apply-command argument: ${String(argument)}`);
  }

  if (!candidateId || !/^\d+$/.test(candidateId)) {
    throw new Error('--candidate <id> is required and must be numeric');
  }

  if (!action || !VALID_CLI_ACTIONS.includes(action as CliAction)) {
    throw new Error(
      `--action is required and must be one of: ${VALID_CLI_ACTIONS.join(', ')}`,
    );
  }

  if (action === 'edit' && (payload === null || payload.trim().length === 0)) {
    throw new Error('edit action requires --payload "<new text>"');
  }

  if (action === 'attach_photos' && (photos === null || photos.length === 0)) {
    throw new Error('attach_photos action requires --photos <json array of {fileId}>');
  }

  return {
    candidateId,
    action: action as CliAction,
    payload,
    photos,
    mediaGroupId,
    replyMessageId,
  };
}

async function runAttachPhotos(input: {
  candidateId: string;
  photos: PhotoInput[];
  mediaGroupId: string | null;
  replyMessageId: number | null;
}): Promise<void> {
  const pool = await getPool();
  try {
    const candidatesRepository = createCandidatesRepository(pool);
    const mediaBatchJson = {
      kind: 'telegram_photo_batch' as const,
      replyMessageId: input.replyMessageId ?? 0,
      mediaGroupId: input.mediaGroupId,
      capturedAt: new Date().toISOString(),
      photos: input.photos.map((photo) => ({
        fileId: photo.fileId,
        fileUniqueId: photo.fileUniqueId ?? photo.fileId,
        width: photo.width ?? 0,
        height: photo.height ?? 0,
      })),
    };

    const updated = await candidatesRepository.replaceMediaBatchByCandidateId({
      candidateId: input.candidateId,
      allowedStatuses: ['pending_approval', 'reminded', 'held'],
      mediaBatchJson,
    });

    if (!updated) {
      throw new Error(
        `Candidate ${input.candidateId} is not in an allowed state for attach_photos (must be pending_approval | reminded | held)`,
      );
    }

    process.stdout.write(
      `${JSON.stringify({
        candidateId: updated.id,
        status: updated.status,
        photoCount: input.photos.length,
      })}\n`,
    );
  } finally {
    await pool.end();
  }
}

export async function runApplyCommand(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = parseArgs(argv);

  if (args.action === 'attach_photos') {
    await runAttachPhotos({
      candidateId: args.candidateId,
      photos: args.photos!,
      mediaGroupId: args.mediaGroupId,
      replyMessageId: args.replyMessageId,
    });
    return;
  }

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
