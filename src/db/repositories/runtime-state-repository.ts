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
  return {
    stateKey: row.state_key,
    stateJson: row.state_json,
    updatedAt: row.updated_at,
  };
}

export function createRuntimeStateRepository(db: Queryable) {
  return {
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
  };
}
