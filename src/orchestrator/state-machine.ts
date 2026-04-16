import { createCandidatesRepository, type CandidateRecord } from '../db/repositories/candidates-repository';
import type { Queryable } from '../db/pool';
import type { TelegramControlAction } from '../telegram/command-parser';

export type CandidateStatus =
  | 'selector_skipped'
  | 'drafting'
  | 'drafter_skipped'
  | 'pending_approval'
  | 'reminded'
  | 'held'
  | 'skipped'
  | 'post_requested'
  | 'published'
  | 'delivery_failed';

export type CandidateTimerEffect = 'send_reminder' | 'request_post' | null;

export type CandidateActionResult = {
  candidate: CandidateRecord | null;
  applied: boolean;
};

type CandidateRow = {
  id: string;
  trigger_type: string;
  candidate_type: string;
  status: string;
  deadline_at: Date | null;
  reminder_sent_at: Date | null;
  selector_output_json: unknown;
  drafter_output_json: unknown;
  final_post_text: string | null;
  quote_target_url: string | null;
  media_request: string | null;
  telegram_message_id: string | null;
  media_batch_json: unknown;
  degraded: boolean;
  error_details: string | null;
  created_at: Date;
  updated_at: Date;
};

const ACTIVE_APPROVAL_STATUSES = ['pending_approval', 'reminded', 'held'] as const;
const AUTOMATION_CANDIDATE_STATUSES = [...ACTIVE_APPROVAL_STATUSES, 'post_requested'] as const;
const AUTO_POSTABLE_STATUSES = ['pending_approval', 'reminded'] as const;

function mapCandidateRow(row: CandidateRow): CandidateRecord {
  return {
    id: row.id,
    triggerType: row.trigger_type,
    candidateType: row.candidate_type,
    status: row.status,
    deadlineAt: row.deadline_at,
    reminderSentAt: row.reminder_sent_at,
    selectorOutputJson: row.selector_output_json,
    drafterOutputJson: row.drafter_output_json,
    finalPostText: row.final_post_text,
    quoteTargetUrl: row.quote_target_url,
    mediaRequest: row.media_request,
    telegramMessageId: row.telegram_message_id,
    mediaBatchJson: row.media_batch_json,
    degraded: row.degraded,
    errorDetails: row.error_details,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isActiveApprovalStatus(status: string): boolean {
  return ACTIVE_APPROVAL_STATUSES.includes(status as (typeof ACTIVE_APPROVAL_STATUSES)[number]);
}

export async function getCandidateById(db: Queryable, candidateId: string): Promise<CandidateRecord | null> {
  const result = await db.query<CandidateRow>(
    `
      select
        id,
        trigger_type,
        candidate_type,
        status,
        deadline_at,
        reminder_sent_at,
        selector_output_json,
        drafter_output_json,
        final_post_text,
        quote_target_url,
        media_request,
        telegram_message_id,
        media_batch_json,
        degraded,
        error_details,
        created_at,
        updated_at
      from sp_post_candidates
      where id = $1
    `,
    [candidateId],
  );
  const row = result.rows[0];

  return row ? mapCandidateRow(row) : null;
}

export async function listCandidatesForAutomation(db: Queryable): Promise<CandidateRecord[]> {
  const result = await db.query<CandidateRow>(
    `
      select
        id,
        trigger_type,
        candidate_type,
        status,
        deadline_at,
        reminder_sent_at,
        selector_output_json,
        drafter_output_json,
        final_post_text,
        quote_target_url,
        media_request,
        telegram_message_id,
        media_batch_json,
        degraded,
        error_details,
        created_at,
        updated_at
      from sp_post_candidates
      where status = any($1::text[])
      order by id asc
    `,
    [AUTOMATION_CANDIDATE_STATUSES],
  );

  return result.rows.map(mapCandidateRow);
}

export function getCandidateTimerEffect(input: {
  candidate: CandidateRecord;
  now: Date;
}): CandidateTimerEffect {
  if (input.candidate.triggerType !== 'scheduled' || input.candidate.deadlineAt === null) {
    return null;
  }

  if (input.candidate.status === 'held') {
    return null;
  }

  if (
    AUTO_POSTABLE_STATUSES.includes(input.candidate.status as (typeof AUTO_POSTABLE_STATUSES)[number])
    && input.candidate.deadlineAt.getTime() <= input.now.getTime()
  ) {
    return 'request_post';
  }

  return null;
}

export async function markReminderSent(input: {
  db: Queryable;
  candidateId: string;
  now: () => Date;
}): Promise<CandidateRecord | null> {
  return createCandidatesRepository(input.db).transitionStatus({
    id: input.candidateId,
    fromStatuses: ['pending_approval'],
    toStatus: 'reminded',
    reminderSentAt: input.now(),
    errorDetails: null,
  });
}

export async function markDeliveryFailed(input: {
  db: Queryable;
  candidateId: string;
  errorDetails: string;
}): Promise<CandidateRecord | null> {
  return createCandidatesRepository(input.db).transitionStatus({
    id: input.candidateId,
    fromStatuses: ['pending_approval'],
    toStatus: 'delivery_failed',
    errorDetails: input.errorDetails,
  });
}

export async function requestCandidatePost(input: {
  db: Queryable;
  candidateId: string;
  fromStatuses?: string[] | undefined;
}): Promise<CandidateRecord | null> {
  return createCandidatesRepository(input.db).transitionStatus({
    id: input.candidateId,
    fromStatuses: input.fromStatuses ?? [...AUTO_POSTABLE_STATUSES, 'held'],
    toStatus: 'post_requested',
    errorDetails: null,
  });
}

export async function applyCandidateAction(input: {
  db: Queryable;
  candidateId: string;
  action: TelegramControlAction;
  payload?: string | null | undefined;
  now?: (() => Date) | undefined;
}): Promise<CandidateActionResult> {
  const candidatesRepository = createCandidatesRepository(input.db);

  switch (input.action) {
    case 'skip': {
      const candidate = await candidatesRepository.transitionStatus({
        id: input.candidateId,
        fromStatuses: [...ACTIVE_APPROVAL_STATUSES, 'post_requested', 'delivery_failed'],
        toStatus: 'skipped',
        errorDetails: input.now ? `Skipped at ${input.now().toISOString()}` : null,
      });

      return {
        candidate,
        applied: candidate !== null,
      };
    }

    case 'hold': {
      const candidate = await candidatesRepository.transitionStatus({
        id: input.candidateId,
        fromStatuses: ['pending_approval', 'reminded', 'post_requested'],
        toStatus: 'held',
        errorDetails: null,
      });

      return {
        candidate,
        applied: candidate !== null,
      };
    }

    case 'post_now': {
      const candidate = await requestCandidatePost({
        db: input.db,
        candidateId: input.candidateId,
      });

      return {
        candidate,
        applied: candidate !== null,
      };
    }

    case 'edit': {
      if (!input.payload || input.payload.trim().length === 0) {
        return {
          candidate: await getCandidateById(input.db, input.candidateId),
          applied: false,
        };
      }

      const existingCandidate = await getCandidateById(input.db, input.candidateId);

      if (!existingCandidate || !isActiveApprovalStatus(existingCandidate.status)) {
        return {
          candidate: existingCandidate,
          applied: false,
        };
      }

      const candidate = await candidatesRepository.updateCandidate(input.candidateId, {
        finalPostText: input.payload.trim(),
        errorDetails: null,
      });

      return {
        candidate,
        applied: true,
      };
    }

    case 'another_angle':
      return {
        candidate: await getCandidateById(input.db, input.candidateId),
        applied: false,
      };
  }
}
