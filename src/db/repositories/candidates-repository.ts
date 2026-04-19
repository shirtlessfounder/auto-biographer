import type { Queryable } from '../pool';

export type CandidateRecord = {
  id: string;
  triggerType: string;
  candidateType: string;
  status: string;
  deadlineAt: Date | null;
  reminderSentAt: Date | null;
  selectorOutputJson: unknown;
  drafterOutputJson: unknown;
  finalPostText: string | null;
  quoteTargetUrl: string | null;
  mediaRequest: string | null;
  telegramMessageId: string | null;
  mediaBatchJson: unknown;
  degraded: boolean;
  errorDetails: string | null;
  publishAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateCandidateInput = {
  triggerType: string;
  candidateType: string;
  status: string;
  deadlineAt?: Date | null | undefined;
  reminderSentAt?: Date | null | undefined;
  selectorOutputJson?: unknown;
  drafterOutputJson?: unknown;
  finalPostText?: string | null | undefined;
  quoteTargetUrl?: string | null | undefined;
  mediaRequest?: string | null | undefined;
  telegramMessageId?: string | null | undefined;
  mediaBatchJson?: unknown;
  degraded?: boolean | undefined;
  errorDetails?: string | null | undefined;
  publishAt?: Date | null | undefined;
};

export type CandidateUpdateInput = {
  deadlineAt?: Date | null | undefined;
  reminderSentAt?: Date | null | undefined;
  selectorOutputJson?: unknown;
  drafterOutputJson?: unknown;
  finalPostText?: string | null | undefined;
  quoteTargetUrl?: string | null | undefined;
  mediaRequest?: string | null | undefined;
  telegramMessageId?: string | null | undefined;
  mediaBatchJson?: unknown;
  degraded?: boolean | undefined;
  errorDetails?: string | null | undefined;
  publishAt?: Date | null | undefined;
};

export type TransitionStatusInput = CandidateUpdateInput & {
  id: string;
  fromStatuses: string[];
  toStatus: string;
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
  publish_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toJsonbValue(value: unknown): string {
  return JSON.stringify(value);
}

function hasOwn<T extends object>(value: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function mapCandidateRow(row: CandidateRow): CandidateRecord {
  return {
    id: row.id,
    triggerType: row.trigger_type,
    candidateType: row.candidate_type,
    status: row.status,
    deadlineAt: row.deadline_at ? new Date(row.deadline_at as unknown as string) : null,
    reminderSentAt: row.reminder_sent_at ? new Date(row.reminder_sent_at as unknown as string) : null,
    selectorOutputJson: row.selector_output_json,
    drafterOutputJson: row.drafter_output_json,
    finalPostText: row.final_post_text,
    quoteTargetUrl: row.quote_target_url,
    mediaRequest: row.media_request,
    telegramMessageId: row.telegram_message_id,
    mediaBatchJson: row.media_batch_json,
    degraded: row.degraded,
    errorDetails: row.error_details,
    publishAt: row.publish_at ? new Date(row.publish_at as unknown as string) : null,
    createdAt: new Date(row.created_at as unknown as string),
    updatedAt: new Date(row.updated_at as unknown as string),
  };
}

function buildMutableAssignments(
  input: CandidateUpdateInput,
  values: unknown[],
  assignments: string[],
): void {
  if (hasOwn(input, 'deadlineAt')) {
    values.push(input.deadlineAt ?? null);
    assignments.push(`deadline_at = $${String(values.length)}`);
  }

  if (hasOwn(input, 'reminderSentAt')) {
    values.push(input.reminderSentAt ?? null);
    assignments.push(`reminder_sent_at = $${String(values.length)}`);
  }

  if (hasOwn(input, 'selectorOutputJson')) {
    values.push(toJsonbValue(input.selectorOutputJson ?? null));
    assignments.push(`selector_output_json = $${String(values.length)}`);
  }

  if (hasOwn(input, 'drafterOutputJson')) {
    values.push(toJsonbValue(input.drafterOutputJson ?? null));
    assignments.push(`drafter_output_json = $${String(values.length)}`);
  }

  if (hasOwn(input, 'finalPostText')) {
    values.push(input.finalPostText ?? null);
    assignments.push(`final_post_text = $${String(values.length)}`);
  }

  if (hasOwn(input, 'quoteTargetUrl')) {
    values.push(input.quoteTargetUrl ?? null);
    assignments.push(`quote_target_url = $${String(values.length)}`);
  }

  if (hasOwn(input, 'mediaRequest')) {
    values.push(input.mediaRequest ?? null);
    assignments.push(`media_request = $${String(values.length)}`);
  }

  if (hasOwn(input, 'telegramMessageId')) {
    values.push(input.telegramMessageId ?? null);
    assignments.push(`telegram_message_id = $${String(values.length)}`);
  }

  if (hasOwn(input, 'mediaBatchJson')) {
    values.push(toJsonbValue(input.mediaBatchJson ?? null));
    assignments.push(`media_batch_json = $${String(values.length)}`);
  }

  if (hasOwn(input, 'degraded')) {
    values.push(input.degraded ?? false);
    assignments.push(`degraded = $${String(values.length)}`);
  }

  if (hasOwn(input, 'errorDetails')) {
    values.push(input.errorDetails ?? null);
    assignments.push(`error_details = $${String(values.length)}`);
  }

  if (hasOwn(input, 'publishAt')) {
    values.push(input.publishAt ?? null);
    assignments.push(`publish_at = $${String(values.length)}`);
  }
}

export function createCandidatesRepository(db: Queryable) {
  return {
    async createCandidate(input: CreateCandidateInput): Promise<CandidateRecord> {
      let result: QueryResult<CandidateRow>;
      try {
        result = await db.query<CandidateRow>(
          `
            insert into sp_post_candidates (
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
              publish_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            returning
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
              publish_at,
              created_at,
              updated_at
          `,
          [
            input.triggerType,
            input.candidateType,
            input.status,
            input.deadlineAt ?? null,
            input.reminderSentAt ?? null,
            toJsonbValue(input.selectorOutputJson ?? null),
            toJsonbValue(input.drafterOutputJson ?? null),
            input.finalPostText ?? null,
            input.quoteTargetUrl ?? null,
            input.mediaRequest ?? null,
            input.telegramMessageId ?? null,
            toJsonbValue(input.mediaBatchJson ?? null),
            input.degraded ?? false,
            input.errorDetails ?? null,
            input.publishAt ?? null,
          ],
        );
      } catch (e) {
        console.error(`[createCandidate] query threw:`, e);
        throw e;
      }

      console.error(`[createCandidate] INSERT result: ${JSON.stringify(result)}`);

      const row = result.rows[0];
      console.error(`[createCandidate] rows.length=${result.rows.length}, row=${JSON.stringify(row)}, input.status=${input.status}`);

      if (!row) {
        throw new Error(`Candidate insert did not return a row (status=${input.status})`);
      }

      return mapCandidateRow(row);
    },

    async updateCandidate(id: string, input: CandidateUpdateInput): Promise<CandidateRecord> {
      const values: unknown[] = [id];
      const assignments: string[] = [];

      buildMutableAssignments(input, values, assignments);
      assignments.push('updated_at = now()');

      const result = await db.query<CandidateRow>(
        `
          update sp_post_candidates
          set ${assignments.join(', ')}
          where id = $1
          returning
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
            publish_at,
            created_at,
            updated_at
        `,
        values,
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error(`Candidate ${id} was not found`);
      }

      return mapCandidateRow(row);
    },

    async transitionStatus(input: TransitionStatusInput): Promise<CandidateRecord | null> {
      if (input.fromStatuses.length === 0) {
        throw new Error('fromStatuses must include at least one status');
      }

      const values: unknown[] = [input.id];
      const fromPlaceholders: string[] = [];
      const fromStatusPlaceholders = input.fromStatuses.map((_, i) => {
        values.push(input.fromStatuses[i]!);
        fromPlaceholders.push(`$${values.length}`);
        return fromPlaceholders[fromPlaceholders.length - 1]!;
      }).join(', ');
      const assignments: string[] = [];

      buildMutableAssignments(input, values, assignments);
      values.push(input.toStatus);
      assignments.push(`status = $${String(values.length)}`);
      assignments.push('updated_at = now()');

      console.error(`[transitionStatus] input: id=${input.id}, fromStatuses=${JSON.stringify(input.fromStatuses)}, toStatus=${input.toStatus}, values=${JSON.stringify(values)}, sql=UPDATE sp_post_candidates SET ${assignments.join(', ')} WHERE id = $1 AND status IN (${fromPlaceholders})`);
      const result = await db.query<CandidateRow>(
        `
          update sp_post_candidates
          set ${assignments.join(', ')}
          where id = $1
            and status IN (${fromStatusPlaceholders})
          returning
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
            publish_at,
            created_at,
            updated_at
        `,
        values,
      );

      const row = result.rows[0];
      console.error(`[transitionStatus] UPDATE RETURNING result: rowCount=${result.rowCount}, row=${JSON.stringify(row)}`);

      return row ? mapCandidateRow(row) : null;
    },

    async replaceMediaBatchByTelegramMessageId(input: {
      telegramMessageId: string;
      allowedStatuses: string[];
      mediaBatchJson: unknown;
    }): Promise<CandidateRecord | null> {
      if (input.allowedStatuses.length === 0) {
        throw new Error('allowedStatuses must include at least one status');
      }

      const statusPlaceholders = input.allowedStatuses.map((_, i) => `$${i + 2}`).join(', ');
      const result = await db.query<CandidateRow>(
        `
          update sp_post_candidates
          set media_batch_json = $3,
              updated_at = now()
          where telegram_message_id = $1
            and status IN (${statusPlaceholders})
          returning
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
            publish_at,
            created_at,
            updated_at
        `,
        [
          input.telegramMessageId,
          input.allowedStatuses,
          toJsonbValue(input.mediaBatchJson),
        ],
      );

      const row = result.rows[0];

      return row ? mapCandidateRow(row) : null;
    },
  };
}
