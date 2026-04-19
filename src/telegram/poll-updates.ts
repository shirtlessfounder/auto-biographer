import { z } from 'zod';

import { collectTelegramPhotoReplyBatches } from './photo-batches';
import { parseTelegramControlUpdate, type ParsedTelegramControlAction } from './command-parser';
import type { TelegramClient, TelegramUpdate } from './client';

export const TELEGRAM_UPDATES_OFFSET_STATE_KEY = 'telegram_control_bot_update_offset';

export type PollTelegramUpdatesResult = {
  processedUpdateCount: number;
  storedActionCount: number;
  nextUpdateOffset: number | null;
  actions: ParsedTelegramControlAction[];
};

type RuntimeStateRepository = {
  getState(stateKey: string): Promise<{ stateJson: unknown } | null>;
  setState(stateKey: string, stateJson: unknown): Promise<unknown>;
};

type TelegramActionsRepository = {
  recordAction(input: {
    candidateId: string;
    telegramUpdateId: string;
    action: string;
    payload?: string | null | undefined;
  }): Promise<unknown>;
};

type CandidateMediaRepository = {
  replaceMediaBatchByTelegramMessageId(input: {
    telegramMessageId: string;
    allowedStatuses: string[];
    mediaBatchJson: unknown;
  }): Promise<unknown>;
};

type CreateTelegramUpdatePollerInput = {
  client: TelegramClient;
  runtimeStateRepository: RuntimeStateRepository;
  telegramActionsRepository: TelegramActionsRepository;
  candidateMediaRepository: CandidateMediaRepository;
  controlChatId: string;
  now?: (() => Date) | undefined;
};

type PollUpdatesInput = {
  limit?: number | undefined;
  timeoutSeconds?: number | undefined;
};

const TelegramOffsetStateSchema = z.object({
  updateOffset: z.number().int().nonnegative(),
});

function sortUpdatesAscending(updates: TelegramUpdate[]): TelegramUpdate[] {
  return [...updates].sort((left, right) => left.update_id - right.update_id);
}

function readStoredUpdateOffset(stateJson: unknown): number {
  const parsed = TelegramOffsetStateSchema.safeParse(stateJson);

  if (!parsed.success) {
    throw new Error('Stored Telegram update offset is invalid');
  }

  return parsed.data.updateOffset;
}

export function createTelegramUpdatePoller(input: CreateTelegramUpdatePollerInput) {
  const now = input.now ?? (() => new Date());

  return {
    async pollUpdates(request: PollUpdatesInput = {}): Promise<PollTelegramUpdatesResult> {
      // If the bot token is not configured (e.g. platform hasn't injected it in this env),
      // skip polling and return empty results so the tick can still run.
      const botToken = (input.client as { botToken?: string }).botToken;
      if (!botToken) {
        return {
          processedUpdateCount: 0,
          storedActionCount: 0,
          nextUpdateOffset: null,
          actions: [],
        };
      }

      const storedState = await input.runtimeStateRepository.getState(
        TELEGRAM_UPDATES_OFFSET_STATE_KEY,
      );
      const offset = storedState ? readStoredUpdateOffset(storedState.stateJson) : undefined;
      const updates = sortUpdatesAscending(
        await input.client.getUpdates({
          offset,
          limit: request.limit,
          timeoutSeconds: request.timeoutSeconds,
        }),
      );
      const actions: ParsedTelegramControlAction[] = [];
      const controlChatUpdates: TelegramUpdate[] = [];
      let nextUpdateOffset: number | null = offset ?? null;

      for (const update of updates) {
        nextUpdateOffset = update.update_id + 1;

        if (String(update.message?.chat.id ?? '') !== input.controlChatId) {
          continue;
        }

        controlChatUpdates.push(update);

        const parsedAction = parseTelegramControlUpdate(update);

        if (!parsedAction) {
          continue;
        }

        await input.telegramActionsRepository.recordAction({
          candidateId: parsedAction.candidateId,
          telegramUpdateId: parsedAction.updateId,
          action: parsedAction.action,
          payload: parsedAction.payload,
        });
        actions.push(parsedAction);
      }

      for (const batch of collectTelegramPhotoReplyBatches(controlChatUpdates)) {
        await input.candidateMediaRepository.replaceMediaBatchByTelegramMessageId({
          telegramMessageId: String(batch.replyMessageId),
          allowedStatuses: ['pending_approval', 'reminded', 'held'],
          mediaBatchJson: {
            kind: 'telegram_photo_batch',
            replyMessageId: batch.replyMessageId,
            mediaGroupId: batch.mediaGroupId,
            capturedAt: now().toISOString(),
            photos: batch.photos,
          },
        });
      }

      if (nextUpdateOffset !== null && updates.length > 0) {
        await input.runtimeStateRepository.setState(TELEGRAM_UPDATES_OFFSET_STATE_KEY, {
          updateOffset: nextUpdateOffset,
        });
      }

      return {
        processedUpdateCount: updates.length,
        storedActionCount: actions.length,
        nextUpdateOffset,
        actions,
      };
    },
  };
}
