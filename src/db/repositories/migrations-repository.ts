import type { Queryable } from '../pool';

type SchemaMigrationRow = {
  version: string;
};

export function createMigrationsRepository(db: Queryable) {
  return {
    async ensureSchemaMigrationsTable(): Promise<void> {
      await db.query(`
        create table if not exists schema_migrations (
          version text primary key,
          applied_at timestamptz not null default now()
        );
      `);
    },

    async listAppliedMigrations(): Promise<string[]> {
      const result = await db.query<SchemaMigrationRow>(`
        select version
        from schema_migrations
        order by version asc
      `);

      return result.rows.map((row) => row.version);
    },

    async recordAppliedMigration(version: string): Promise<void> {
      await db.query(
        `
          insert into schema_migrations (version)
          values ($1)
          on conflict (version) do nothing
        `,
        [version],
      );
    },
  };
}
