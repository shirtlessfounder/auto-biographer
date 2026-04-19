import { z } from 'zod';

const DatabaseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'postgres:' || protocol === 'postgresql:';
  }, 'DATABASE_URL must use the postgres or postgresql protocol');

const CsvListSchema = z.string().min(1).transform((value, context) => {
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (items.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected at least one comma-separated value',
    });
    return z.NEVER;
  }

  return items;
});

const WindowsJsonSchema = z.string().min(1).transform((value, context) => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'WINDOWS_JSON must be valid JSON',
    });
    return z.NEVER;
  }

  if (!Array.isArray(parsed)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'WINDOWS_JSON must decode to a JSON array',
    });
    return z.NEVER;
  }

  return parsed;
});

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1).optional(),  // optional — MCP client uses MCP_DB_URL, not this
  TELEGRAM_CONTROL_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CONTROL_CHAT_ID: z.string().regex(/^-?\d+$/).optional(),
  TELEGRAM_API_BASE_URL: z.string().url().optional(),
  HERMES_BIN: z.string().min(1).optional(),
  X_BEARER_TOKEN: z.string().min(1).optional(),
  GITHUB_USERNAME: z.string().min(1).optional(),
  INNIES_API_KEY: z.string().min(1).optional(),
  INNIES_BUYER_KEY_ID: z.string().min(1).optional(),
  INNIES_BUYER_KEY_NAME: z.string().min(1).optional(),
  SLACK_AUTHOR_NAMES: CsvListSchema.optional(),
  SLACK_AUTHOR_USER_IDS: CsvListSchema.optional(),
  POST_PROFILE: z.string().min(1).optional(),
  CLAWD_TWEET_SCRIPT: z.string().min(1).optional(),
  WINDOWS_JSON: WindowsJsonSchema.optional(),
  // X OAuth 1.0a — new, loaded from .env
  X_CONSUMER_KEY: z.string().min(1).optional(),
  X_CONSUMER_SECRET: z.string().min(1).optional(),
  X_ACCESS_TOKEN: z.string().min(1).optional(),
  X_ACCESS_TOKEN_SECRET: z.string().min(1).optional(),
  X_API_BASE_URL: z.string().url().optional(),
  PUBLISH_GRACE_MINUTES: z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number.parseInt(value, 10))
    .optional(),
});

export type AppEnv = {
  databaseUrl: string;
  telegramControlBotToken: string;
  telegramControlChatId: string;
  telegramApiBaseUrl?: string | undefined;
  hermesBin: string;
  xBearerToken: string;
  githubUsername: string;
  inniesBuyerKeyName: string;
  slackAuthorNames: string[];
  slackAuthorUserIds: string[];
  postProfile: string;
  clawdTweetScript: string;
  windowsJson: unknown[];
  publishGraceMinutes: number;
};

export function loadEnv(input: Record<string, string | undefined> = process.env): AppEnv {
  const parsed = EnvSchema.parse(input);

  return {
    databaseUrl: parsed.DATABASE_URL,
    telegramControlBotToken: parsed.TELEGRAM_CONTROL_BOT_TOKEN,
    telegramControlChatId: parsed.TELEGRAM_CONTROL_CHAT_ID,
    telegramApiBaseUrl: parsed.TELEGRAM_API_BASE_URL,
    hermesBin: parsed.HERMES_BIN,
    xBearerToken: parsed.X_BEARER_TOKEN,
    githubUsername: parsed.GITHUB_USERNAME,
    inniesApiKey: parsed.INNIES_API_KEY,
    inniesBuyerKeyId: parsed.INNIES_BUYER_KEY_ID,
    inniesBuyerKeyName: parsed.INNIES_BUYER_KEY_NAME,
    slackAuthorNames: parsed.SLACK_AUTHOR_NAMES ?? [],
    slackAuthorUserIds: parsed.SLACK_AUTHOR_USER_IDS ?? [],
    postProfile: parsed.POST_PROFILE,
    clawdTweetScript: parsed.CLAWD_TWEET_SCRIPT,
    windowsJson: parsed.WINDOWS_JSON,
    publishGraceMinutes: parsed.PUBLISH_GRACE_MINUTES ?? 10,
  };
}
