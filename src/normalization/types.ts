export type NormalizedEventSource =
  | 'github'
  | 'agent_conversation'
  | 'slack_message'
  | 'slack_link';

export interface NormalizedArtifactRef {
  artifactType: string;
  artifactKey: string;
}

export interface NormalizedArtifactInput extends NormalizedArtifactRef {
  contentText?: string | null | undefined;
  contentJson?: unknown;
  sourceUrl?: string | null | undefined;
}

export interface NormalizedEventInput {
  source: NormalizedEventSource;
  sourceId: string;
  occurredAt: Date;
  author?: string | null | undefined;
  urlOrLocator?: string | null | undefined;
  title?: string | null | undefined;
  summary?: string | null | undefined;
  rawText?: string | null | undefined;
  tags?: readonly string[] | undefined;
  rawPayload?: unknown;
  artifactRefs?: readonly NormalizedArtifactRef[] | undefined;
  artifacts?: readonly NormalizedArtifactInput[] | undefined;
}

export interface PersistedArtifactRecord {
  id: string;
  eventId: string;
  artifactType: string;
  artifactKey: string;
  contentText: string | null;
  contentJson: unknown;
  sourceUrl: string | null;
  createdAt: Date;
}
