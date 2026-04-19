import { z } from 'zod';

const OAuthEnvSchema = z.object({
  X_CONSUMER_KEY: z.string().min(1),
  X_CONSUMER_SECRET: z.string().min(1),
  X_ACCESS_TOKEN: z.string().min(1),
  X_ACCESS_TOKEN_SECRET: z.string().min(1),
});

export type OAuthEnv = z.infer<typeof OAuthEnvSchema>;

export function loadOAuthEnv(input: Record<string, string | undefined> = process.env): OAuthEnv {
  const parsed = OAuthEnvSchema.parse(input);

  return {
    X_CONSUMER_KEY: parsed.X_CONSUMER_KEY,
    X_CONSUMER_SECRET: parsed.X_CONSUMER_SECRET,
    X_ACCESS_TOKEN: parsed.X_ACCESS_TOKEN,
    X_ACCESS_TOKEN_SECRET: parsed.X_ACCESS_TOKEN_SECRET,
  };
}
