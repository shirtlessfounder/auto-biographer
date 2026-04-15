import { describe, expect, it } from 'vitest';
import * as commandParser from '../../../src/telegram/command-parser';

import {
  formatCandidatePackageMessage,
  parseTelegramControlUpdate,
} from '../../../src/telegram/command-parser';

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
  it('formats skip notifications as plain informational messages', () => {
    const formatter = (commandParser as Record<string, unknown>).formatSkipNotificationMessage;

    expect(typeof formatter).toBe('function');

    if (typeof formatter !== 'function') {
      return;
    }

    expect(
      formatter({
        stage: 'drafter',
        triggerType: 'on_demand',
        candidateId: '456',
        candidateType: 'ship_update',
        reason: 'Not concrete enough yet',
      }),
    ).toBe([
      'Skipped: drafter',
      'Trigger: on_demand',
      'Type: ship_update',
      'Reason: Not concrete enough yet',
      'Ref: 456',
    ].join('\n'));
  });

  it('formats candidate packages without a visible candidate header and still leaves a parseable ref', () => {
    const message = formatCandidatePackageMessage({
      candidateId: '123',
      candidateType: 'ship_update',
      deadlineAt: new Date('2026-04-15T14:16:03.000Z'),
      draftText: 'Ship the orchestrator update in the lead tweet.',
      mediaRequest: 'annotated screenshot of the shipping flow',
    });

    expect(message.startsWith('Candidate #123')).toBe(false);
    expect(message).toContain('Type: ship_update');
    expect(message).toContain('Media request: annotated screenshot of the shipping flow');
    expect(message).toContain('Ref: 123');
  });

  it('formats thread packages with a repo-link reply preview', () => {
    const message = formatCandidatePackageMessage({
      candidateId: '456',
      candidateType: 'ship_update',
      draftText: 'Lead tweet for a shipped project.',
      deliveryKind: 'thread',
      threadReplyText: 'https://github.com/dylanvu/auto-biographer',
    });

    expect(message).toContain('Delivery: thread');
    expect(message).toContain('Reply:');
    expect(message).toContain('https://github.com/dylanvu/auto-biographer');
  });

  it('parses the supported reply commands for a candidate package', () => {
    const replyText = 'Type: ship_update\nDraft:\nship it\n\nRef: 123\nReply with: skip | hold | post now | edit: ... | another angle';

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
        replyText: 'Type: ship_update\nDraft:\nold version\n\nRef: 456\nReply with: skip | hold | post now | edit: ... | another angle',
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
          replyText: 'Type: ship_update\nDraft:\nship it\n\nRef: 123\nReply with: skip | hold | post now | edit: ... | another angle',
        }),
      ),
    ).toBeNull();

    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'edit:',
          replyText: 'Type: ship_update\nDraft:\nship it\n\nRef: 123\nReply with: skip | hold | post now | edit: ... | another angle',
        }),
      ),
    ).toBeNull();

    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'SKIP',
          replyText: 'Type: ship_update\nDraft:\nship it\n\nRef: 123\nReply with: skip | hold | post now | edit: ... | another angle',
        }),
      ),
    ).toBeNull();
  });

  it('rejects updates that are not user replies to a candidate package', () => {
    expect(
      parseTelegramControlUpdate(
        buildReplyUpdate({
          text: 'skip',
          replyText: 'Type: ship_update\nDraft:\nship it\n\nRef: 123\nReply with: skip | hold | post now | edit: ... | another angle',
        }),
      ),
    ).toMatchObject({
      candidateId: '123',
      action: 'skip',
    });

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
