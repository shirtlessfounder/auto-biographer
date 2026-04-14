import type { Queryable } from '../pool';

export type EventRecord = {
  id: string;
  source: string;
  sourceId: string;
  occurredAt: Date;
  author: string | null;
  urlOrLocator: string | null;
  title: string | null;
  summary: string | null;
  rawText: string | null;
  tags: unknown;
  artifactRefs: unknown;
  rawPayload: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type UpsertEventInput = {
  source: string;
  sourceId: string;
  occurredAt: Date;
  author?: string | null | undefined;
  urlOrLocator?: string | null | undefined;
  title?: string | null | undefined;
  summary?: string | null | undefined;
  rawText?: string | null | undefined;
  tags?: unknown;
  artifactRefs?: unknown;
  rawPayload?: unknown;
};

type EventRow = {
  id: string;
  source: string;
  source_id: string;
  occurred_at: Date;
  author: string | null;
  url_or_locator: string | null;
  title: string | null;
  summary: string | null;
  raw_text: string | null;
  tags: unknown;
  artifact_refs: unknown;
  raw_payload: unknown;
  created_at: Date;
  updated_at: Date;
};

function toJsonbValue(value: unknown): string {
  return JSON.stringify(value);
}

function mapEventRow(row: EventRow): EventRecord {
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    occurredAt: row.occurred_at,
    author: row.author,
    urlOrLocator: row.url_or_locator,
    title: row.title,
    summary: row.summary,
    rawText: row.raw_text,
    tags: row.tags,
    artifactRefs: row.artifact_refs,
    rawPayload: row.raw_payload,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createEventsRepository(db: Queryable) {
  return {
    async upsertEvent(input: UpsertEventInput): Promise<EventRecord> {
      const result = await db.query<EventRow>(
        `
          insert into sp_events (
            source,
            source_id,
            occurred_at,
            author,
            url_or_locator,
            title,
            summary,
            raw_text,
            tags,
            artifact_refs,
            raw_payload
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          on conflict (source, source_id) do update
          set occurred_at = excluded.occurred_at,
              author = excluded.author,
              url_or_locator = excluded.url_or_locator,
              title = excluded.title,
              summary = excluded.summary,
              raw_text = excluded.raw_text,
              tags = excluded.tags,
              artifact_refs = excluded.artifact_refs,
              raw_payload = excluded.raw_payload,
              updated_at = now()
          returning
            id,
            source,
            source_id,
            occurred_at,
            author,
            url_or_locator,
            title,
            summary,
            raw_text,
            tags,
            artifact_refs,
            raw_payload,
            created_at,
            updated_at
        `,
        [
          input.source,
          input.sourceId,
          input.occurredAt,
          input.author ?? null,
          input.urlOrLocator ?? null,
          input.title ?? null,
          input.summary ?? null,
          input.rawText ?? null,
          toJsonbValue(input.tags ?? []),
          toJsonbValue(input.artifactRefs ?? []),
          toJsonbValue(input.rawPayload ?? null),
        ],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error('Event upsert did not return a row');
      }

      return mapEventRow(row);
    },
  };
}
