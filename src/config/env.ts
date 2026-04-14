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
  DATABASE_URL: DatabaseUrlSchema,
  TELEGRAM_CONTROL_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CONTROL_CHAT_ID: z.string().regex(/^-?\d+$/),
  HERMES_BIN: z.string().min(1),
  GITHUB_USERNAME: z.string().min(1),
  INNIES_BUYER_KEY_NAME: z.string().min(1),
  SLACK_AUTHOR_NAMES: CsvListSchema,
  SLACK_AUTHOR_USER_IDS: CsvListSchema,
  POST_PROFILE: z.string().min(1),
  CLAWD_TWEET_SCRIPT: z.string().min(1),
  WINDOWS_JSON: WindowsJsonSchema,
});

export type AppEnv = {
  databaseUrl: string;
  telegramControlBotToken: string;
  telegramControlChatId: string;
  hermesBin: string;
  githubUsername: string;
  inniesBuyerKeyName: string;
  slackAuthorNames: string[];
  slackAuthorUserIds: string[];
  postProfile: string;
  clawdTweetScript: string;
  windowsJson: unknown[];
};

export function loadEnv(input: Record<string, string | undefined> = process.env): AppEnv {
  const parsed = EnvSchema.parse(input);

  return {
    databaseUrl: parsed.DATABASE_URL,
    telegramControlBotToken: parsed.TELEGRAM_CONTROL_BOT_TOKEN,
    telegramControlChatId: parsed.TELEGRAM_CONTROL_CHAT_ID,
    hermesBin: parsed.HERMES_BIN,
    githubUsername: parsed.GITHUB_USERNAME,
    inniesBuyerKeyName: parsed.INNIES_BUYER_KEY_NAME,
    slackAuthorNames: parsed.SLACK_AUTHOR_NAMES,
    slackAuthorUserIds: parsed.SLACK_AUTHOR_USER_IDS,
    postProfile: parsed.POST_PROFILE,
    clawdTweetScript: parsed.CLAWD_TWEET_SCRIPT,
    windowsJson: parsed.WINDOWS_JSON,
  };
}
