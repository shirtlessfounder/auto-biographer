import { createCandidatesRepository } from '../db/repositories/candidates-repository';
import { createCandidateControlMessagesRepository } from '../db/repositories/candidate-control-messages-repository';
import type { Queryable } from '../db/pool';
import {
  applyCandidateAction,
  type CandidateStatus,
} from '../orchestrator/state-machine';
import {
  parseTelegramControlReply,
  type TelegramControlAction,
} from '../telegram/command-parser';
import type { TelegramPhotoBatchPhoto } from '../telegram/photo-batches';

const ACTIVE_CONTROL_STATUSES: CandidateStatus[] = ['pending_approval', 'reminded', 'held'];

export type DraftControlIngressResult = 'matched_and_applied' | 'matched_but_ignored' | 'not_a_control_reply';

export async function ingestDraftControlTextReply(input: {
  db: Queryable;
  telegramUpdateId: string;
  telegramMessageId: string;
  actorUserId: string | null;
  replyToTelegramMessageId: string;
  text: string;
  now?: (() => Date) | undefined;
}): Promise<{
  result: DraftControlIngressResult;
  candidateId: string | null;
  action: TelegramControlAction | null;
}> {
  const controlMessagesRepository = createCandidateControlMessagesRepository(input.db);
  const matchedCandidate = await controlMessagesRepository.findCandidateByTelegramMessageId({
    telegramMessageId: input.replyToTelegramMessageId,
  });

  if (!matchedCandidate) {
    return { result: 'not_a_control_reply', candidateId: null, action: null };
  }

  const parsedReply = parseTelegramControlReply({
    text: input.text,
    replyMessageText: `Ref: ${matchedCandidate.candidateId}`,
  });

  if (!parsedReply) {
    return { result: 'matched_but_ignored', candidateId: matchedCandidate.candidateId, action: null };
  }

  const actionResult = await applyCandidateAction({
    db: input.db,
    candidateId: matchedCandidate.candidateId,
    action: parsedReply.action,
    payload: parsedReply.payload,
    now: input.now,
  });

  return {
    result: actionResult.applied ? 'matched_and_applied' : 'matched_but_ignored',
    candidateId: matchedCandidate.candidateId,
    action: parsedReply.action,
  };
}

export async function ingestDraftControlPhotoReply(input: {
  db: Queryable;
  telegramUpdateId: string;
  telegramMessageId: string;
  actorUserId: string | null;
  replyToTelegramMessageId: string;
  mediaGroupId: string | null;
  photos: TelegramPhotoBatchPhoto[];
  now?: (() => Date) | undefined;
}): Promise<{
  result: DraftControlIngressResult;
  candidateId: string | null;
}> {
  const controlMessagesRepository = createCandidateControlMessagesRepository(input.db);
  const matchedCandidate = await controlMessagesRepository.findCandidateByTelegramMessageId({
    telegramMessageId: input.replyToTelegramMessageId,
    allowedStatuses: ACTIVE_CONTROL_STATUSES,
  });

  if (!matchedCandidate) {
    const anyCandidate = await controlMessagesRepository.findCandidateByTelegramMessageId({
      telegramMessageId: input.replyToTelegramMessageId,
    });

    return {
      result: anyCandidate ? 'matched_but_ignored' : 'not_a_control_reply',
      candidateId: anyCandidate?.candidateId ?? null,
    };
  }

  const replaced = await createCandidatesRepository(input.db).replaceMediaBatchByTelegramMessageId({
    telegramMessageId: input.replyToTelegramMessageId,
    allowedStatuses: ACTIVE_CONTROL_STATUSES,
    mediaBatchJson: {
      kind: 'telegram_photo_batch',
      replyMessageId: Number(input.replyToTelegramMessageId),
      mediaGroupId: input.mediaGroupId,
      capturedAt: (input.now ?? (() => new Date()))().toISOString(),
      photos: input.photos,
    },
  });

  return {
    result: replaced ? 'matched_and_applied' : 'matched_but_ignored',
    candidateId: matchedCandidate.candidateId,
  };
}
