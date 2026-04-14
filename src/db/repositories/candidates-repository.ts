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
  degraded: boolean;
  errorDetails: string | null;
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
  degraded?: boolean | undefined;
  errorDetails?: string | null | undefined;
};

export type CandidateUpdateInput = {
  deadlineAt?: Date | null | undefined;
  reminderSentAt?: Date | null | undefined;
  selectorOutputJson?: unknown;
  drafterOutputJson?: unknown;
  finalPostText?: string | null | undefined;
  quoteTargetUrl?: string | null | undefined;
  mediaRequest?: string | null | undefined;
  degraded?: boolean | undefined;
  errorDetails?: string | null | undefined;
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
  degraded: boolean;
  error_details: string | null;
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
    deadlineAt: row.deadline_at,
    reminderSentAt: row.reminder_sent_at,
    selectorOutputJson: row.selector_output_json,
    drafterOutputJson: row.drafter_output_json,
    finalPostText: row.final_post_text,
    quoteTargetUrl: row.quote_target_url,
    mediaRequest: row.media_request,
    degraded: row.degraded,
    errorDetails: row.error_details,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

  if (hasOwn(input, 'degraded')) {
    values.push(input.degraded ?? false);
    assignments.push(`degraded = $${String(values.length)}`);
  }

  if (hasOwn(input, 'errorDetails')) {
    values.push(input.errorDetails ?? null);
    assignments.push(`error_details = $${String(values.length)}`);
  }
}

export function createCandidatesRepository(db: Queryable) {
  return {
    async createCandidate(input: CreateCandidateInput): Promise<CandidateRecord> {
      const result = await db.query<CandidateRow>(
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
            degraded,
            error_details
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
            degraded,
            error_details,
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
          input.degraded ?? false,
          input.errorDetails ?? null,
        ],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error('Candidate insert did not return a row');
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
            degraded,
            error_details,
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

      const values: unknown[] = [input.id, input.fromStatuses, input.toStatus];
      const assignments = ['status = $3'];

      buildMutableAssignments(input, values, assignments);
      assignments.push('updated_at = now()');

      const result = await db.query<CandidateRow>(
        `
          update sp_post_candidates
          set ${assignments.join(', ')}
          where id = $1
            and status = any($2::text[])
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
            degraded,
            error_details,
            created_at,
            updated_at
        `,
        values,
      );

      const row = result.rows[0];

      return row ? mapCandidateRow(row) : null;
    },
  };
}
