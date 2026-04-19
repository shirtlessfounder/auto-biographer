import type { Pool, PoolClient } from 'pg';
import type { Queryable } from '../db/pool';
import { createEventsRepository, type EventRecord } from '../db/repositories/events-repository';
import type {
  NormalizedArtifactInput,
  NormalizedArtifactRef,
  NormalizedEventInput,
  PersistedArtifactRecord,
} from './types';

type ArtifactRow = {
  id: string;
  event_id: string;
  artifact_type: string;
  artifact_key: string;
  content_text: string | null;
  content_json: unknown;
  source_url: string | null;
  created_at: Date;
};

type UpsertEventsDb = Pool | Queryable;

export interface UpsertedNormalizedEvent {
  event: EventRecord;
  artifacts: PersistedArtifactRecord[];
}

function toJsonbValue(value: unknown): string {
  return JSON.stringify(value);
}

function artifactSignature(artifact: NormalizedArtifactRef): string {
  return `${artifact.artifactType}:${artifact.artifactKey}`;
}

function dedupeArtifactRefs(
  artifactRefs: readonly NormalizedArtifactRef[] | undefined,
  artifacts: readonly NormalizedArtifactInput[] | undefined,
): NormalizedArtifactRef[] {
  const seen = new Set<string>();
  const deduped: NormalizedArtifactRef[] = [];

  for (const artifactRef of artifactRefs ?? []) {
    const signature = artifactSignature(artifactRef);

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    deduped.push({
      artifactType: artifactRef.artifactType,
      artifactKey: artifactRef.artifactKey,
    });
  }

  for (const artifact of artifacts ?? []) {
    const signature = artifactSignature(artifact);

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    deduped.push({
      artifactType: artifact.artifactType,
      artifactKey: artifact.artifactKey,
    });
  }

  return deduped;
}

function dedupeArtifacts(artifacts: readonly NormalizedArtifactInput[] | undefined): NormalizedArtifactInput[] {
  const seen = new Set<string>();
  const deduped: NormalizedArtifactInput[] = [];

  for (const artifact of artifacts ?? []) {
    const signature = artifactSignature(artifact);

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    deduped.push(artifact);
  }

  return deduped;
}

function mapArtifactRow(row: ArtifactRow): PersistedArtifactRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    artifactType: row.artifact_type,
    artifactKey: row.artifact_key,
    contentText: row.content_text,
    contentJson: row.content_json,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
  };
}

async function upsertArtifact(
  client: Queryable,
  eventId: string,
  artifact: NormalizedArtifactInput,
): Promise<PersistedArtifactRecord> {
  const result = await client.query<ArtifactRow>(
    `
      insert into sp_artifacts (
        event_id,
        artifact_type,
        artifact_key,
        content_text,
        content_json,
        source_url
      )
      values ($1, $2, $3, $4, $5, $6)
      on conflict (event_id, artifact_type, artifact_key) do update
      set content_text = excluded.content_text,
          content_json = excluded.content_json,
          source_url = excluded.source_url
      returning
        id,
        event_id,
        artifact_type,
        artifact_key,
        content_text,
        content_json,
        source_url,
        created_at
    `,
    [
      eventId,
      artifact.artifactType,
      artifact.artifactKey,
      artifact.contentText ?? null,
      toJsonbValue(artifact.contentJson ?? null),
      artifact.sourceUrl ?? null,
    ],
  );

  const row = result.rows[0];

  if (!row) {
    throw new Error(`Artifact upsert for ${artifact.artifactKey} did not return a row`);
  }

  return mapArtifactRow(row);
}

async function withTransaction<T>(
  db: UpsertEventsDb,
  callback: (client: Queryable) => Promise<T>,
): Promise<T> {
  if (isPool(db)) {
    const client = await db.connect();

    try {
      await client.query('begin');
      const result = await callback(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  await db.query('begin');

  try {
    const result = await callback(db);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  }
}

function isPool(db: Pool | PoolClient | Queryable): db is Pool {
  return 'totalCount' in db;
}

export async function upsertEvents(
  db: UpsertEventsDb,
  events: readonly NormalizedEventInput[],
): Promise<UpsertedNormalizedEvent[]> {
  return withTransaction(db, async (client) => {
    const eventsRepository = createEventsRepository(client);
    const persistedEvents: UpsertedNormalizedEvent[] = [];

    for (const event of events) {
      const artifacts = dedupeArtifacts(event.artifacts);
      const artifactRefs = dedupeArtifactRefs(event.artifactRefs, artifacts);
      const persistedEvent = await eventsRepository.upsertEvent({
        source: event.source,
        sourceId: event.sourceId,
        occurredAt: event.occurredAt,
        author: event.author ?? null,
        urlOrLocator: event.urlOrLocator ?? null,
        title: event.title ?? null,
        summary: event.summary ?? null,
        rawText: event.rawText ?? null,
        tags: Array.from(event.tags ?? []),
        artifactRefs,
        rawPayload: event.rawPayload ?? null,
      });
      const persistedArtifacts: PersistedArtifactRecord[] = [];

      for (const artifact of artifacts) {
        persistedArtifacts.push(await upsertArtifact(client, persistedEvent.id, artifact));
      }

      persistedEvents.push({
        event: persistedEvent,
        artifacts: persistedArtifacts,
      });
    }

    return persistedEvents;
  });
}
