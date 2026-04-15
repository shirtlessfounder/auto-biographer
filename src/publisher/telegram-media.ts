import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { TelegramClient } from '../telegram/client';
import type { TelegramPhotoBatchPhoto } from '../telegram/photo-batches';

type TelegramPhotoBatchJson = {
  kind: 'telegram_photo_batch';
  replyMessageId: number;
  mediaGroupId: string | null;
  capturedAt: string;
  photos: TelegramPhotoBatchPhoto[];
};

function isTelegramPhotoBatchJson(value: unknown): value is TelegramPhotoBatchJson {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return record.kind === 'telegram_photo_batch' && Array.isArray(record.photos);
}

function getFileExtension(filePath: string): string {
  const extension = path.extname(filePath).trim();

  return extension.length > 0 ? extension : '.jpg';
}

export async function materializeTelegramPhotoBatch(input: {
  telegramClient: TelegramClient;
  mediaBatchJson: unknown;
}): Promise<{ mediaPaths: string[]; cleanup: () => Promise<void> }> {
  if (!isTelegramPhotoBatchJson(input.mediaBatchJson)) {
    throw new Error('Invalid telegram photo batch');
  }

  if (input.mediaBatchJson.photos.length < 1 || input.mediaBatchJson.photos.length > 4) {
    throw new Error('Telegram photo batches must contain between 1 and 4 photos');
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'auto-biographer-media-'));
  const cleanup = async () => {
    await rm(directory, { force: true, recursive: true });
  };

  try {
    const mediaPaths: string[] = [];

    for (const [index, photo] of input.mediaBatchJson.photos.entries()) {
      const telegramFile = await input.telegramClient.getFile(photo.fileId);
      const response = await fetch(telegramFile.downloadUrl);

      if (!response.ok) {
        throw new Error(`Failed to download Telegram file ${telegramFile.fileId}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      const mediaPath = path.join(directory, `${String(index + 1)}${getFileExtension(telegramFile.filePath)}`);

      await writeFile(mediaPath, bytes);
      mediaPaths.push(mediaPath);
    }

    return { mediaPaths, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
