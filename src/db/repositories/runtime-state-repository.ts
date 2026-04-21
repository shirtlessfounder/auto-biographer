import type { Queryable } from '../pool';

export type RuntimeStateRecord = {
  stateKey: string;
  stateJson: unknown;
  updatedAt: Date;
};

type RuntimeStateRow = {
  state_key: string;
  state_json: unknown;
  updated_at: Date;
};

function toJsonbValue(value: unknown): string {
  return JSON.stringify(value);
}

function mapRuntimeStateRow(row: RuntimeStateRow): RuntimeStateRecord {
  const raw = typeof row.state_json === 'string' ? row.state_json : JSON.stringify(row.state_json);
  const parsed = JSON.parse(raw);
  return {
    stateKey: row.state_key,
    stateJson: parsed,
    updatedAt: new Date(row.updated_at),
  };
}

export function createRuntimeStateRepository(db: Queryable) {
  return {
    async listStatesByPrefix(stateKeyPrefix: string): Promise<RuntimeStateRecord[]> {
      const result = await db.query<RuntimeStateRow>(
        `
          select state_key, state_json, updated_at
          from sp_runtime_state
          where state_key like $1
          order by state_key asc
        `,
        [`${stateKeyPrefix}%`],
      );

      return result.rows.map(mapRuntimeStateRow);
    },

    async getState(stateKey: string): Promise<RuntimeStateRecord | null> {
      const result = await db.query<RuntimeStateRow>(
        `
          select state_key, state_json, updated_at
          from sp_runtime_state
          where state_key = $1
        `,
        [stateKey],
      );

      const row = result.rows[0];

      return row ? mapRuntimeStateRow(row) : null;
    },

    async setState(stateKey: string, stateJson: unknown): Promise<RuntimeStateRecord> {
      const result = await db.query<RuntimeStateRow>(
        `
          insert into sp_runtime_state (state_key, state_json)
          values ($1, $2)
          on conflict (state_key) do update
          set state_json = excluded.state_json,
              updated_at = now()
          returning state_key, state_json, updated_at
        `,
        [stateKey, toJsonbValue(stateJson)],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error('Runtime state upsert did not return a row');
      }

      return mapRuntimeStateRow(row);
    },

    async claimSlotState(
      stateKey: string,
      newStateJson: unknown,
    ): Promise<{ outcome: 'inserted' | 'retry' | 'conflict' | 'stale'; attemptCount: number } | null> {
      const newStateStr = toJsonbValue(newStateJson);

      // Step 1: Always UPDATE — MCP corrupts WHERE clauses but RETURNING is accurate.
      // status and updated_at come from the DB row (before SET changes them).
      const updateResult = await db.query<{ old_status: string; attempt_count: number }>(
        `
          update sp_runtime_state
          set state_json = $2,
              updated_at = now()
          where state_key = $1
          returning
            (state_json->>'status') as old_status,
            coalesce(($2::jsonb->>'attemptCount'), '1')::int as attempt_count
        `,
        [stateKey, newStateStr],
      );

      console.error(`[claimSlotState] update rows: ${JSON.stringify(updateResult.rows)}, rowCount: ${updateResult.rowCount}`);
      if (updateResult.rows.length > 0) {
        const { old_status, attempt_count } = updateResult.rows[0]!;
        console.error(`[claimSlotState] old_status=${JSON.stringify(old_status)}, attempt_count=${attempt_count}`);
        if (old_status === 'retry_pending') return { outcome: 'retry', attemptCount: attempt_count };
        // Slot was in_progress (stale or not) — we've now claimed it.
        return { outcome: 'conflict', attemptCount: attempt_count };
      }

      // Step 2: Row didn't exist — INSERT
      const insertResult = await db.query<RuntimeStateRow>(
        `
          insert into sp_runtime_state (state_key, state_json)
          values ($1, $2)
          on conflict (state_key) do nothing
          returning state_key, state_json, updated_at
        `,
        [stateKey, newStateStr],
      );

      if (insertResult.rows.length > 0) return { outcome: 'inserted', attemptCount: 1 };

      return { outcome: 'conflict', attemptCount: 1 };
    },

    async setState(stateKey: string, stateJson: unknown): Promise<RuntimeStateRecord> {
      const result = await db.query<RuntimeStateRow>(
        `
          insert into sp_runtime_state (state_key, state_json)
          values ($1, $2)
          on conflict (state_key) do update
          set state_json = excluded.state_json,
              updated_at = now()
          returning state_key, state_json, updated_at
        `,
        [stateKey, toJsonbValue(stateJson)],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error('Runtime state upsert did not return a row');
      }

      return mapRuntimeStateRow(row);
    },

    async insertStateIfAbsent(stateKey: string, stateJson: unknown): Promise<RuntimeStateRecord | null> {
      const result = await db.query<RuntimeStateRow>(
        `
          insert into sp_runtime_state (state_key, state_json)
          values ($1, $2)
          on conflict (state_key) do nothing
          returning state_key, state_json, updated_at
        `,
        [stateKey, toJsonbValue(stateJson)],
      );

      const row = result.rows[0];

      return row ? mapRuntimeStateRow(row) : null;
    },

    async setStateIfStatus(
      stateKey: string,
      expectedStatus: string,
      stateJson: unknown,
    ): Promise<RuntimeStateRecord | null> {
      const result = await db.query<RuntimeStateRow>(
        `
          update sp_runtime_state
          set state_json = $2,
              updated_at = now()
          where state_key = $1
            and state_json ->> 'status' = $3
          returning state_key, state_json, updated_at
        `,
        [stateKey, toJsonbValue(stateJson), expectedStatus],
      );

      const row = result.rows[0];

      return row ? mapRuntimeStateRow(row) : null;
    },

    /**
     * Atomically claim a stale in_progress slot by resetting it to retry_pending.
     * Returns the updated row if the slot was stale and is now claimed.
     * Returns null if the slot doesn't exist, isn't in_progress, or isn't stale.
     */
    async claimStaleSlot(
      stateKey: string,
      attemptCount: number,
      STALE_THRESHOLD_MS: number,
    ): Promise<RuntimeStateRecord | null> {
      const result = await db.query<RuntimeStateRow>(
        `
          update sp_runtime_state
          set state_json = jsonb_set(
                jsonb_set(state_json, '{status}', '"retry_pending"'),
                '{attemptCount}',
                $2::text::jsonb
              ),
              updated_at = now()
          where state_key = $1
            and state_json ->> 'status' = 'in_progress'
            and (
              extract(epoch from (now() - updated_at)) * 1000
            ) > $3
          returning state_key, state_json, updated_at
        `,
        [stateKey, String(attemptCount), STALE_THRESHOLD_MS],
      );

      const row = result.rows[0];

      return row ? mapRuntimeStateRow(row) : null;
    },

    async deleteState(stateKey: string): Promise<void> {
      await db.query(
        `
          delete from sp_runtime_state
          where state_key = $1
        `,
        [stateKey],
      );
    },

    /**
     * Bulk-reclaim stuck in_progress slots under a state_key prefix whose
     * updated_at is older than staleThresholdMs. Flips status to retry_pending
     * so the normal claim flow can pick them up.
     * Returns the set of reclaimed state keys.
     */
    async reapStuckSlots(
      stateKeyPrefix: string,
      staleThresholdMs: number,
    ): Promise<RuntimeStateRecord[]> {
      const result = await db.query<RuntimeStateRow>(
        `
          update sp_runtime_state
          set state_json = jsonb_set(state_json, '{status}', '"retry_pending"'),
              updated_at = now()
          where state_key like $1
            and state_json ->> 'status' = 'in_progress'
            and (
              extract(epoch from (now() - updated_at)) * 1000
            ) > $2
          returning state_key, state_json, updated_at
        `,
        [`${stateKeyPrefix}%`, staleThresholdMs],
      );

      return result.rows.map(mapRuntimeStateRow);
    },
  };
}
