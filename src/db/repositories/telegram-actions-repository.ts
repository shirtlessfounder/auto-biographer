import type { Queryable } from '../pool';

export type TelegramActionRecord = {
  id: string;
  candidateId: string;
  telegramUpdateId: string;
  action: string;
  payload: string | null;
  createdAt: Date;
};

export type RecordTelegramActionInput = {
  candidateId: string;
  telegramUpdateId: string;
  action: string;
  payload?: string | null | undefined;
};

type TelegramActionRow = {
  id: string;
  candidate_id: string;
  telegram_update_id: string;
  action: string;
  payload: string | null;
  created_at: Date;
};

function mapTelegramActionRow(row: TelegramActionRow): TelegramActionRecord {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    telegramUpdateId: row.telegram_update_id,
    action: row.action,
    payload: row.payload,
    createdAt: row.created_at,
  };
}

export function createTelegramActionsRepository(db: Queryable) {
  return {
    async recordAction(input: RecordTelegramActionInput): Promise<TelegramActionRecord> {
      const result = await db.query<TelegramActionRow>(
        `
          with inserted as (
            insert into sp_telegram_actions (
              candidate_id,
              telegram_update_id,
              action,
              payload
            )
            values ($1, $2, $3, $4)
            on conflict (telegram_update_id) do nothing
            returning
              id,
              candidate_id,
              telegram_update_id,
              action,
              payload,
              created_at
          )
          select
            id,
            candidate_id,
            telegram_update_id,
            action,
            payload,
            created_at
          from inserted
          union all
          select
            id,
            candidate_id,
            telegram_update_id,
            action,
            payload,
            created_at
          from sp_telegram_actions
          where telegram_update_id = $2
            and not exists (select 1 from inserted)
          limit 1
        `,
        [
          input.candidateId,
          input.telegramUpdateId,
          input.action,
          input.payload ?? null,
        ],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error('Telegram action insert did not return a row');
      }

      return mapTelegramActionRow(row);
    },
  };
}
