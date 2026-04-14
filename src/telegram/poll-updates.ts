import { z } from 'zod';

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

type CreateTelegramUpdatePollerInput = {
  client: TelegramClient;
  runtimeStateRepository: RuntimeStateRepository;
  telegramActionsRepository: TelegramActionsRepository;
  controlChatId: string;
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
  return {
    async pollUpdates(request: PollUpdatesInput = {}): Promise<PollTelegramUpdatesResult> {
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
      let nextUpdateOffset: number | null = offset ?? null;

      for (const update of updates) {
        nextUpdateOffset = update.update_id + 1;

        if (String(update.message?.chat.id ?? '') !== input.controlChatId) {
          continue;
        }

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
