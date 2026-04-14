import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../../src/config/env';

const validEnv = {
  DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/social_posting',
  TELEGRAM_CONTROL_BOT_TOKEN: '123456:control-token',
  TELEGRAM_CONTROL_CHAT_ID: '-1001234567890',
  HERMES_BIN: '/usr/local/bin/hermes',
  GITHUB_USERNAME: 'dylanvu',
  INNIES_BUYER_KEY_NAME: 'shirtless',
  SLACK_AUTHOR_NAMES: 'Dylan Vu, dylan',
  SLACK_AUTHOR_USER_IDS: 'U12345, U67890',
  POST_PROFILE: 'default',
  CLAWD_TWEET_SCRIPT: '/home/ubuntu/clawd/scripts/tweet.js',
  WINDOWS_JSON: '[{"name":"weekday-morning","start":"09:00","end":"11:00"}]',
};

describe('loadEnv', () => {
  it('requires the core runtime settings', () => {
    expect(() =>
      loadEnv({
        DATABASE_URL: validEnv.DATABASE_URL,
      }),
    ).toThrowError();
  });

  it('parses list settings and windows json', () => {
    expect(loadEnv(validEnv)).toEqual({
      databaseUrl: validEnv.DATABASE_URL,
      telegramControlBotToken: validEnv.TELEGRAM_CONTROL_BOT_TOKEN,
      telegramControlChatId: validEnv.TELEGRAM_CONTROL_CHAT_ID,
      hermesBin: validEnv.HERMES_BIN,
      githubUsername: validEnv.GITHUB_USERNAME,
      inniesBuyerKeyName: validEnv.INNIES_BUYER_KEY_NAME,
      slackAuthorNames: ['Dylan Vu', 'dylan'],
      slackAuthorUserIds: ['U12345', 'U67890'],
      postProfile: validEnv.POST_PROFILE,
      clawdTweetScript: validEnv.CLAWD_TWEET_SCRIPT,
      windowsJson: [{ name: 'weekday-morning', start: '09:00', end: '11:00' }],
    });
  });

  it('rejects invalid windows json', () => {
    expect(() =>
      loadEnv({
        ...validEnv,
        WINDOWS_JSON: 'not-json',
      }),
    ).toThrowError(/WINDOWS_JSON/i);
  });
});
