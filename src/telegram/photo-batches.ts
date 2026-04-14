import type { TelegramPhotoSize, TelegramUpdate } from './client';

export type TelegramPhotoBatchPhoto = {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
};

export type TelegramPhotoBatch = {
  kind: 'telegram_photo_batch';
  replyMessageId: number;
  mediaGroupId: string | null;
  photos: TelegramPhotoBatchPhoto[];
};

function pickLargestPhoto(photos: readonly TelegramPhotoSize[]): TelegramPhotoBatchPhoto | null {
  let largest: TelegramPhotoSize | null = null;

  for (const photo of photos) {
    if (largest === null) {
      largest = photo;
      continue;
    }

    const currentArea = photo.width * photo.height;
    const largestArea = largest.width * largest.height;

    if (currentArea > largestArea) {
      largest = photo;
    }
  }

  if (largest === null) {
    return null;
  }

  return {
    fileId: largest.file_id,
    fileUniqueId: largest.file_unique_id,
    width: largest.width,
    height: largest.height,
  };
}

function getBatchKey(replyMessageId: number, mediaGroupId: string | null): string {
  return `${String(replyMessageId)}:${mediaGroupId ?? 'single'}`;
}

export function collectTelegramPhotoReplyBatches(
  updates: readonly TelegramUpdate[],
): TelegramPhotoBatch[] {
  const batches = new Map<string, TelegramPhotoBatch>();
  const orderedKeys: string[] = [];

  for (const update of updates) {
    const message = update.message;
    const replyMessageId = message?.reply_to_message?.message_id;
    const photo = message?.photo;

    if (!message || replyMessageId === undefined || !photo || photo.length === 0) {
      continue;
    }

    const largestPhoto = pickLargestPhoto(photo);

    if (largestPhoto === null) {
      continue;
    }

    const mediaGroupId = message.media_group_id ?? null;
    const key = getBatchKey(replyMessageId, mediaGroupId);
    const existing = batches.get(key);

    if (existing) {
      existing.photos.push(largestPhoto);
      continue;
    }

    orderedKeys.push(key);
    batches.set(key, {
      kind: 'telegram_photo_batch',
      replyMessageId,
      mediaGroupId,
      photos: [largestPhoto],
    });
  }

  return orderedKeys
    .map((key) => batches.get(key))
    .filter((batch): batch is TelegramPhotoBatch => batch !== undefined);
}
