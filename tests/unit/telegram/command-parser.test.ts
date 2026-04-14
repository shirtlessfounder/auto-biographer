import { describe, expect, it } from 'vitest';

import { parseTelegramControlUpdate } from '../../../src/telegram/command-parser';

function buildReplyUpdate(input: {
  updateId?: number;
  text: string;
  replyText?: string;
  fromIsBot?: boolean;
}) {
  return {
    update_id: input.updateId ?? 9001,
    message: {
      message_id: 77,
      chat: {
        id: -1001234567890,
        type: 'supergroup',
      },
      from: {
        id: 42,
        is_bot: input.fromIsBot ?? false,
      },
      text: input.text,
      reply_to_message: input.replyText
        ? {
            message_id: 76,
            text: input.replyText,
          }
        : undefined,
    },
  };
}

describe('parseTelegramControlUpdate', () => {
  it('parses the supported reply commands for a candidate package', () => {
    const replyText = 'Candidate #123\nDraft:\nship it';

    expect(parseTelegramControlUpdate(buildReplyUpdate({ text: 'skip', replyText }))).toEqual({
      updateId: '9001',
      messageId: '77',
      chatId: '-1001234567890',
      actorUserId: '42',
      candidateId: '123',
      action: 'skip',
      payload: null,
    });

    expect(
      parseTelegramControlUpdate(buildReplyUpdate({ updateId: 9002, text: 'hold', replyText })),
    ).toMatchObject({
      updateId: '9002',
      candidateId: '123',
      action: 'hold',
      payload: null,
    });

    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({ updateId: 9003, text: 'post now', replyText }),
      ),
    ).toMatchObject({
      updateId: '9003',
      candidateId: '123',
      action: 'post_now',
      payload: null,
    });

    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({ updateId: 9004, text: 'another angle', replyText }),
      ),
    ).toMatchObject({
      updateId: '9004',
      candidateId: '123',
      action: 'another_angle',
      payload: null,
    });
  });

  it('parses edit commands and trims the edited payload', () => {
    const parsed = parseTelegramControlUpdate(
      buildReplyUpdate({
        text: '  edit:  rewrite with sharper framing  ',
        replyText: 'Candidate #456\nDraft:\nold version',
      }),
    );

    expect(parsed).toEqual({
      updateId: '9001',
      messageId: '77',
      chatId: '-1001234567890',
      actorUserId: '42',
      candidateId: '456',
      action: 'edit',
      payload: 'rewrite with sharper framing',
    });
  });

  it('rejects malformed or ambiguous commands', () => {
    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'skip please',
          replyText: 'Candidate #123\nDraft:\nship it',
        }),
      ),
    ).toBeNull();

    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'edit:',
          replyText: 'Candidate #123\nDraft:\nship it',
        }),
      ),
    ).toBeNull();

    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'SKIP',
          replyText: 'Candidate #123\nDraft:\nship it',
        }),
      ),
    ).toBeNull();
  });

  it('rejects updates that are not user replies to a candidate package', () => {
    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'skip',
          replyText: 'Draft only\nship it',
        }),
      ),
    ).toBeNull();

    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'skip',
        }),
      ),
    ).toBeNull();

    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'skip',
          replyText: 'Candidate #123\nDraft:\nship it',
          fromIsBot: true,
        }),
      ),
    ).toBeNull();

    expect(
      parseTelegramControlUpdate({
        update_id: 9005,
      }),
    ).toBeNull();
  });
});
