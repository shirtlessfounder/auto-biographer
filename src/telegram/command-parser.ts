import type { TelegramUpdate } from './client';

export type TelegramControlAction =
  | 'skip'
  | 'hold'
  | 'post_now'
  | 'edit'
  | 'another_angle';

export type ParsedTelegramControlAction = {
  updateId: string;
  messageId: string;
  chatId: string;
  actorUserId: string | null;
  candidateId: string;
  action: TelegramControlAction;
  payload: string | null;
};

export type ParsedTelegramControlReply = {
  candidateId: string;
  action: TelegramControlAction;
  payload: string | null;
};

export type CandidatePackageMessageInput = {
  candidateId: string;
  draftText: string;
  candidateType?: string | null | undefined;
  deliveryKind?: 'single_post' | 'thread' | undefined;
  deadlineAt?: Date | null | undefined;
  quoteTargetUrl?: string | null | undefined;
  threadReplyText?: string | null | undefined;
  mediaRequest?: string | null | undefined;
};

export type SkipNotificationMessageInput = {
  stage: 'selector' | 'drafter';
  triggerType: 'scheduled' | 'on_demand';
  candidateId: string;
  candidateType?: string | null | undefined;
  reason?: string | null | undefined;
};

const CANDIDATE_HEADER_PATTERN = /^Candidate #(?<candidateId>\d+)(?:$|\n)/;
const CANDIDATE_REF_PATTERN = /(?:^|\n)Ref:\s*(?<candidateId>\d+)(?:$|\n)/;

function normalizeDraftText(draftText: string): string {
  const trimmed = draftText.trim();

  return trimmed.length > 0 ? trimmed : '(empty draft)';
}

function normalizeOptionalLineValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapCommand(commandText: string): {
  action: TelegramControlAction;
  payload: string | null;
} | null {
  switch (commandText) {
    case 'skip':
      return { action: 'skip', payload: null };
    case 'hold':
      return { action: 'hold', payload: null };
    case 'post now':
      return { action: 'post_now', payload: null };
    case 'another angle':
      return { action: 'another_angle', payload: null };
    default:
      break;
  }

  if (!commandText.startsWith('edit:')) {
    return null;
  }

  const payload = commandText.slice('edit:'.length).trim();

  if (payload.length === 0) {
    return null;
  }

  return {
    action: 'edit',
    payload,
  };
}

export function extractCandidateIdFromControlMessage(messageText: string): string | null {
  const refMatch = messageText.match(CANDIDATE_REF_PATTERN);

  if (refMatch?.groups?.candidateId) {
    return refMatch.groups.candidateId;
  }

  const legacyMatch = messageText.trimStart().match(CANDIDATE_HEADER_PATTERN);
  return legacyMatch?.groups?.candidateId ?? null;
}

export function formatCandidatePackageMessage(input: CandidatePackageMessageInput): string {
  const lines = [
    input.candidateType ? `Type: ${input.candidateType}` : null,
    input.deliveryKind === 'thread' ? 'Delivery: thread' : null,
    input.deadlineAt ? `Deadline: ${input.deadlineAt.toISOString()}` : null,
    input.quoteTargetUrl ? `Quote target: ${input.quoteTargetUrl}` : null,
    input.mediaRequest ? `Media request: ${input.mediaRequest}` : null,
    'Draft:',
    normalizeDraftText(input.draftText),
    input.threadReplyText ? '' : null,
    input.threadReplyText ? 'Reply:' : null,
    input.threadReplyText ?? null,
    '',
    `Ref: ${input.candidateId}`,
    'Reply with: skip | hold | post now | edit: ... | another angle',
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

export function formatSkipNotificationMessage(input: SkipNotificationMessageInput): string {
  const candidateType = normalizeOptionalLineValue(input.candidateType);
  const reason = normalizeOptionalLineValue(input.reason);
  const lines = [
    `Skipped: ${input.stage}`,
    `Trigger: ${input.triggerType}`,
    candidateType ? `Type: ${candidateType}` : null,
    reason ? `Reason: ${reason}` : null,
    `Ref: ${input.candidateId}`,
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

export function parseTelegramControlUpdate(update: TelegramUpdate): ParsedTelegramControlAction | null {
  const message = update.message;

  if (!message?.text || message.from?.is_bot) {
    return null;
  }

  const parsedReply = parseTelegramControlReply({
    text: message.text,
    replyMessageText: message.reply_to_message?.text,
  });

  if (!parsedReply) {
    return null;
  }

  return {
    updateId: String(update.update_id),
    messageId: String(message.message_id),
    chatId: String(message.chat.id),
    actorUserId: message.from ? String(message.from.id) : null,
    candidateId: parsedReply.candidateId,
    action: parsedReply.action,
    payload: parsedReply.payload,
  };
}

export function parseTelegramControlReply(input: {
  text: string;
  replyMessageText?: string | null | undefined;
}): ParsedTelegramControlReply | null {
  const candidateId = input.replyMessageText
    ? extractCandidateIdFromControlMessage(input.replyMessageText)
    : null;

  if (!candidateId) {
    return null;
  }

  const command = mapCommand(input.text.trim());

  if (!command) {
    return null;
  }

  return {
    candidateId,
    action: command.action,
    payload: command.payload,
  };
}
