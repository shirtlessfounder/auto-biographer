import type { Queryable } from '../pool';

export type CandidateControlMessageKind = 'draft' | 'reminder' | 'status' | 'publish_failure';

export type CandidateControlMessageRecord = {
  id: string;
  candidateId: string;
  telegramMessageId: string;
  messageKind: CandidateControlMessageKind;
  isActive: boolean;
  createdAt: Date;
};

type CandidateControlMessageRow = {
  id: string;
  candidate_id: string;
  telegram_message_id: string;
  message_kind: CandidateControlMessageKind;
  is_active: boolean;
  created_at: Date;
};

function mapRow(row: CandidateControlMessageRow): CandidateControlMessageRecord {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    telegramMessageId: row.telegram_message_id,
    messageKind: row.message_kind,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export function createCandidateControlMessagesRepository(db: Queryable) {
  return {
    async recordControlMessage(input: {
      candidateId: string;
      telegramMessageId: string;
      messageKind: CandidateControlMessageKind;
      isActive?: boolean | undefined;
    }): Promise<CandidateControlMessageRecord> {
      const result = await db.query<CandidateControlMessageRow>(
        `
          insert into sp_candidate_control_messages (
            candidate_id,
            telegram_message_id,
            message_kind,
            is_active
          )
          values ($1, $2, $3, $4)
          on conflict (telegram_message_id) do update
          set candidate_id = excluded.candidate_id,
              message_kind = excluded.message_kind,
              is_active = excluded.is_active
          returning
            id,
            candidate_id,
            telegram_message_id,
            message_kind,
            is_active,
            created_at
        `,
        [input.candidateId, input.telegramMessageId, input.messageKind, input.isActive ?? true],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error('Candidate control message insert did not return a row');
      }

      return mapRow(row);
    },

    async listControlMessages(candidateId: string): Promise<CandidateControlMessageRecord[]> {
      const result = await db.query<CandidateControlMessageRow>(
        `
          select
            id,
            candidate_id,
            telegram_message_id,
            message_kind,
            is_active,
            created_at
          from sp_candidate_control_messages
          where candidate_id = $1
          order by id asc
        `,
        [candidateId],
      );

      return result.rows.map(mapRow);
    },

    async deactivateControlMessages(input: {
      candidateId: string;
      messageKinds?: CandidateControlMessageKind[] | undefined;
    }): Promise<number> {
      const result = await db.query<{ count: string }>(
        input.messageKinds && input.messageKinds.length > 0
          ? `
              with updated as (
                update sp_candidate_control_messages
                set is_active = false
                where candidate_id = $1
                  and message_kind = any($2::text[])
                  and is_active = true
                returning 1
              )
              select count(*)::text as count from updated
            `
          : `
              with updated as (
                update sp_candidate_control_messages
                set is_active = false
                where candidate_id = $1
                  and is_active = true
                returning 1
              )
              select count(*)::text as count from updated
            `,
        input.messageKinds && input.messageKinds.length > 0
          ? [input.candidateId, input.messageKinds]
          : [input.candidateId],
      );

      return Number(result.rows[0]?.count ?? '0');
    },

    async findCandidateByTelegramMessageId(input: {
      telegramMessageId: string;
      allowedStatuses?: string[] | undefined;
    }): Promise<{ candidateId: string; candidateStatus: string; messageKind: CandidateControlMessageKind } | null> {
      const result = await db.query<{
        candidate_id: string;
        candidate_status: string;
        message_kind: CandidateControlMessageKind;
      }>(
        input.allowedStatuses && input.allowedStatuses.length > 0
          ? `
              select
                candidate_messages.candidate_id,
                candidates.status as candidate_status,
                candidate_messages.message_kind
              from sp_candidate_control_messages candidate_messages
              join sp_post_candidates candidates
                on candidates.id = candidate_messages.candidate_id
              where candidate_messages.telegram_message_id = $1
                and candidate_messages.is_active = true
                and candidates.status = any($2::text[])
              order by candidate_messages.id desc
              limit 1
            `
          : `
              select
                candidate_messages.candidate_id,
                candidates.status as candidate_status,
                candidate_messages.message_kind
              from sp_candidate_control_messages candidate_messages
              join sp_post_candidates candidates
                on candidates.id = candidate_messages.candidate_id
              where candidate_messages.telegram_message_id = $1
                and candidate_messages.is_active = true
              order by candidate_messages.id desc
              limit 1
            `,
        input.allowedStatuses && input.allowedStatuses.length > 0
          ? [input.telegramMessageId, input.allowedStatuses]
          : [input.telegramMessageId],
      );

      const row = result.rows[0];

      return row
        ? {
            candidateId: row.candidate_id,
            candidateStatus: row.candidate_status,
            messageKind: row.message_kind,
          }
        : null;
    },
  };
}
