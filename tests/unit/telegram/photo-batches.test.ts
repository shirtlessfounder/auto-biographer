import { describe, expect, it } from 'vitest';

import type { TelegramUpdate } from '../../../src/telegram/client';
import { collectTelegramPhotoReplyBatches } from '../../../src/telegram/photo-batches';

function buildPhotoUpdate(input: {
  updateId: number;
  messageId: number;
  replyMessageId: number;
  mediaGroupId?: string | null | undefined;
  photos: Array<{
    fileId: string;
    fileUniqueId: string;
    width: number;
    height: number;
    fileSize?: number | undefined;
  }>;
}): TelegramUpdate {
  return {
    update_id: input.updateId,
    message: {
      message_id: input.messageId,
      chat: {
        id: -1001234567890,
        type: 'supergroup',
      },
      reply_to_message: {
        message_id: input.replyMessageId,
      },
      media_group_id: input.mediaGroupId ?? undefined,
      photo: input.photos.map((photo) => ({
        file_id: photo.fileId,
        file_unique_id: photo.fileUniqueId,
        width: photo.width,
        height: photo.height,
        file_size: photo.fileSize,
      })),
    },
  } as TelegramUpdate;
}

describe('collectTelegramPhotoReplyBatches', () => {
  it('collects a single photo reply batch', () => {
    const batches = collectTelegramPhotoReplyBatches([
      buildPhotoUpdate({
        updateId: 91,
        messageId: 801,
        replyMessageId: 8000,
        photos: [
          { fileId: 'small', fileUniqueId: 'photo-1', width: 320, height: 180 },
          { fileId: 'large', fileUniqueId: 'photo-1', width: 1280, height: 720 },
        ],
      }),
    ]);

    expect(batches).toEqual([
      {
        kind: 'telegram_photo_batch',
        replyMessageId: 8000,
        mediaGroupId: null,
        photos: [
          { fileId: 'large', fileUniqueId: 'photo-1', width: 1280, height: 720 },
        ],
      },
    ]);
  });

  it('groups album replies by reply target and media group id', () => {
    const batches = collectTelegramPhotoReplyBatches([
      buildPhotoUpdate({
        updateId: 92,
        messageId: 802,
        replyMessageId: 8001,
        mediaGroupId: 'album-1',
        photos: [
          { fileId: 'album-1-small', fileUniqueId: 'album-a', width: 400, height: 300 },
          { fileId: 'album-1-large', fileUniqueId: 'album-a', width: 1440, height: 1080 },
        ],
      }),
      buildPhotoUpdate({
        updateId: 93,
        messageId: 803,
        replyMessageId: 8001,
        mediaGroupId: 'album-1',
        photos: [
          { fileId: 'album-2-small', fileUniqueId: 'album-b', width: 400, height: 300 },
          { fileId: 'album-2-large', fileUniqueId: 'album-b', width: 1600, height: 1200 },
        ],
      }),
    ]);

    expect(batches).toEqual([
      {
        kind: 'telegram_photo_batch',
        replyMessageId: 8001,
        mediaGroupId: 'album-1',
        photos: [
          { fileId: 'album-1-large', fileUniqueId: 'album-a', width: 1440, height: 1080 },
          { fileId: 'album-2-large', fileUniqueId: 'album-b', width: 1600, height: 1200 },
        ],
      },
    ]);
  });

  it('keeps later reply batches later in the result order so callers can replace older media', () => {
    const batches = collectTelegramPhotoReplyBatches([
      buildPhotoUpdate({
        updateId: 94,
        messageId: 804,
        replyMessageId: 8002,
        photos: [{ fileId: 'old-large', fileUniqueId: 'old-1', width: 1280, height: 720 }],
      }),
      buildPhotoUpdate({
        updateId: 95,
        messageId: 805,
        replyMessageId: 8002,
        mediaGroupId: 'album-2',
        photos: [{ fileId: 'new-large', fileUniqueId: 'new-1', width: 1600, height: 900 }],
      }),
    ]);

    expect(batches).toEqual([
      {
        kind: 'telegram_photo_batch',
        replyMessageId: 8002,
        mediaGroupId: null,
        photos: [{ fileId: 'old-large', fileUniqueId: 'old-1', width: 1280, height: 720 }],
      },
      {
        kind: 'telegram_photo_batch',
        replyMessageId: 8002,
        mediaGroupId: 'album-2',
        photos: [{ fileId: 'new-large', fileUniqueId: 'new-1', width: 1600, height: 900 }],
      },
    ]);
  });

  it('ignores updates that are not reply photos', () => {
    const batches = collectTelegramPhotoReplyBatches([
      {
        update_id: 96,
        message: {
          message_id: 806,
          chat: {
            id: -1001234567890,
            type: 'supergroup',
          },
          text: 'skip',
        },
      } as TelegramUpdate,
      {
        update_id: 97,
        message: {
          message_id: 807,
          chat: {
            id: -1001234567890,
            type: 'supergroup',
          },
          photo: [
            {
              file_id: 'orphan',
              file_unique_id: 'orphan-1',
              width: 800,
              height: 600,
            },
          ],
        },
      } as TelegramUpdate,
    ]);

    expect(batches).toEqual([]);
  });
});
