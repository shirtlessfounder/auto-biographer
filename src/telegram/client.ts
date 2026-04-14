import { z } from 'zod';

import {
  formatCandidatePackageMessage,
  type CandidatePackageMessageInput,
} from './command-parser';

export type TelegramUser = {
  id: number;
  is_bot: boolean;
  username?: string | undefined;
};

export type TelegramChat = {
  id: number;
  type: string;
};

export type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  date?: number | undefined;
  text?: string | undefined;
  from?: TelegramUser | undefined;
  reply_to_message?:
    | {
        message_id: number;
        text?: string | undefined;
      }
    | undefined;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage | undefined;
};

export type GetTelegramUpdatesInput = {
  offset?: number | undefined;
  limit?: number | undefined;
  timeoutSeconds?: number | undefined;
};

export type SendCandidatePackageInput = CandidatePackageMessageInput;

export type TelegramClient = {
  getUpdates(input?: GetTelegramUpdatesInput | undefined): Promise<TelegramUpdate[]>;
  sendCandidatePackage(input: SendCandidatePackageInput): Promise<TelegramMessage>;
};

type FetchLike = typeof fetch;

type CreateTelegramClientInput = {
  botToken: string;
  chatId: string;
  fetchFn?: FetchLike | undefined;
  apiBaseUrl?: string | undefined;
};

const TelegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  username: z.string().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
});

const TelegramReplyMessageSchema = z.object({
  message_id: z.number().int(),
  text: z.string().optional(),
});

const TelegramMessageSchema = z.object({
  message_id: z.number().int(),
  chat: TelegramChatSchema,
  date: z.number().int().optional(),
  text: z.string().optional(),
  from: TelegramUserSchema.optional(),
  reply_to_message: TelegramReplyMessageSchema.optional(),
});

const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: TelegramMessageSchema.optional(),
});

const TelegramApiErrorSchema = z.object({
  ok: z.literal(false),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
});

function buildSuccessSchema<Result>(resultSchema: z.ZodType<Result>) {
  return z.object({
    ok: z.literal(true),
    result: resultSchema,
  });
}

function buildTelegramApiUrl(apiBaseUrl: string, botToken: string, method: string): string {
  const normalizedBaseUrl = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;

  return `${normalizedBaseUrl}/bot${botToken}/${method}`;
}

async function requestTelegramApi<Result>(input: {
  apiBaseUrl: string;
  botToken: string;
  method: string;
  fetchFn: FetchLike;
  body: Record<string, unknown>;
  resultSchema: z.ZodType<Result>;
}): Promise<Result> {
  const response = await input.fetchFn(
    buildTelegramApiUrl(input.apiBaseUrl, input.botToken, input.method),
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(input.body),
    },
  );

  let json: unknown;

  try {
    json = await response.json();
  } catch {
    throw new Error(`Telegram API ${input.method} returned a non-JSON response`);
  }

  const errorResult = TelegramApiErrorSchema.safeParse(json);

  if (errorResult.success) {
    const description = errorResult.data.description
      ? `: ${errorResult.data.description}`
      : '';

    throw new Error(`Telegram API ${input.method} failed${description}`);
  }

  if (!response.ok) {
    throw new Error(`Telegram API ${input.method} returned HTTP ${response.status}`);
  }

  const parsed = buildSuccessSchema(input.resultSchema).safeParse(json);

  if (!parsed.success) {
    throw new Error(`Telegram API ${input.method} returned an unexpected payload`);
  }

  return parsed.data.result;
}

export function createTelegramClient(input: CreateTelegramClientInput): TelegramClient {
  const fetchFn = input.fetchFn ?? fetch;
  const apiBaseUrl = input.apiBaseUrl ?? 'https://api.telegram.org';

  return {
    async getUpdates(request: GetTelegramUpdatesInput = {}): Promise<TelegramUpdate[]> {
      return requestTelegramApi({
        apiBaseUrl,
        botToken: input.botToken,
        method: 'getUpdates',
        fetchFn,
        body: {
          offset: request.offset,
          limit: request.limit ?? 100,
          timeout: request.timeoutSeconds ?? 0,
          allowed_updates: ['message'],
        },
        resultSchema: z.array(TelegramUpdateSchema),
      });
    },

    async sendCandidatePackage(candidatePackage: SendCandidatePackageInput): Promise<TelegramMessage> {
      return requestTelegramApi({
        apiBaseUrl,
        botToken: input.botToken,
        method: 'sendMessage',
        fetchFn,
        body: {
          chat_id: input.chatId,
          text: formatCandidatePackageMessage(candidatePackage),
          disable_web_page_preview: true,
        },
        resultSchema: TelegramMessageSchema,
      });
    },
  };
}
