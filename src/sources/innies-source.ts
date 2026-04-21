import type { Queryable } from '../db/pool';
import { upsertEvents, type UpsertedNormalizedEvent } from '../normalization/upsert-events';
import type { NormalizedEventInput } from '../normalization/types';

export type InniesSource = {
  sync(): Promise<UpsertedNormalizedEvent[]>;
};

export interface InniesConfig {
  apiKey: string;
  buyerKeyId: string;
  lookbackHours?: number;
}

interface InniesTurn {
  archiveId: string;
  requestId: string;
  attemptNo: number;
  provider: string;
  model: string;
  streaming: boolean;
  status: 'success' | 'failed' | 'partial';
  upstreamStatus: number | null;
  startedAt: string;
  completedAt: string | null;
  messages: InniesMessage[];
}

interface InniesMessage {
  side: 'request' | 'response';
  ordinal: number;
  role: string;
  contentType: string;
  normalizedPayload: string;
}

interface InniesSession {
  sessionKey: string;
  apiKeyId: string;
  startedAt: string;
  lastActivityAt: string;
  turnCount: number;
  providerSet: string[];
  modelSet: string[];
  turns: InniesTurn[];
}

interface InniesApiResponse {
  generatedAt: string;
  windowHours: number;
  pollIntervalSeconds: number;
  apiKeyIds: string[];
  sessions: InniesSession[];
}

async function fetchSessions(config: InniesConfig): Promise<InniesSession[]> {
  const url = `https://innies-api.exe.xyz/v1/admin/me/live-sessions?api_key_ids=${config.buyerKeyId}&window_hours=${config.lookbackHours ?? 24}`;
  const response = await fetch(url, {
    headers: {
      'x-api-key': config.apiKey,
    },
  });

  if (!response.ok) {
    throw new Error(`Innies API returned ${response.status}: ${await response.text()}`);
  }

  const data: InniesApiResponse = await response.json();
  return data.sessions ?? [];
}

function extractText(normalizedPayload: unknown): string {
  if (typeof normalizedPayload === 'string') return normalizedPayload;
  if (typeof normalizedPayload !== 'object' || normalizedPayload === null) return '';
  const payload = normalizedPayload as Record<string, unknown>;
  const content = payload['content'];
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown>;
    if (typeof first === 'object' && first !== null && 'text' in first) {
      return String(first['text'] ?? '');
    }
  }
  return '';
}

function extractTextWithRole(normalizedPayload: unknown): { text: string; role: string } {
  if (typeof normalizedPayload !== 'object' || normalizedPayload === null) return { text: '', role: '' };
  const p = normalizedPayload as Record<string, unknown>;
  const role = typeof p['role'] === 'string' ? p['role'] : '';
  const content = p['content'];
  let text = '';
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown>;
    if (typeof first === 'object' && first !== null && 'text' in first) {
      text = String(first['text'] ?? '');
    }
  }
  return { text, role };
}

function sessionToEvent(session: InniesSession): NormalizedEventInput {
  // Collect all messages sorted by ordinal across all turns
  const allMessages = session.turns
    .flatMap((t) => t.messages)
    .sort((a, b) => a.ordinal - b.ordinal);

  // Build a concise text summary: first non-system user message + first assistant response
  const userMessages = allMessages.filter(
    (m) => m.side === 'request' && extractTextWithRole(m.normalizedPayload).role === 'user'
  );
  const responseMessages = allMessages.filter(
    (m) => m.side === 'response' && extractTextWithRole(m.normalizedPayload).role === 'assistant'
  );

  const firstRequest = extractTextWithRole(userMessages[0]?.normalizedPayload).text;
  const firstResponse = extractTextWithRole(responseMessages[0]?.normalizedPayload).text;

  const summaryLines: string[] = [];
  if (firstRequest) {
    summaryLines.push(`User: ${firstRequest.slice(0, 500)}`);
  }
  if (firstResponse) {
    summaryLines.push(`Agent: ${firstResponse.slice(0, 500)}`);
  }

  const primaryModel = session.modelSet[0] ?? 'unknown';
  const primaryProvider = session.providerSet[0] ?? 'unknown';
  const agentLabel = primaryProvider === 'openai' ? 'codex' : 'claude';

  return {
    source: 'agent_conversation',
    sourceId: session.sessionKey,
    occurredAt: new Date(session.lastActivityAt),
    author: 'dylan',
    urlOrLocator: null,
    title: `[${agentLabel}] ${firstRequest.slice(0, 120) || 'CLI session'}`,
    summary: summaryLines.join('\n') || null,
    rawText: summaryLines.join('\n') || null,
    tags: [agentLabel, primaryModel],
    rawPayload: {
      sessionKey: session.sessionKey,
      turnCount: session.turnCount,
      providerSet: session.providerSet,
      modelSet: session.modelSet,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      turns: session.turns.map((t) => ({
        provider: t.provider,
        model: t.model,
        status: t.status,
        messageCount: t.messages.length,
        requestPreview: t.messages
          .filter((m) => m.side === 'request')
          .map((m) => extractTextWithRole(m.normalizedPayload).text.slice(0, 300))
          .join('\n---\n'),
      })),
    },
  };
}

export function createInniesSource(db: Queryable, config: InniesConfig): InniesSource {
  return {
    async sync(): Promise<UpsertedNormalizedEvent[]> {
      const sessions = await fetchSessions(config);
      console.error(`[innies] fetched ${sessions.length} sessions over last ${config.lookbackHours ?? 24}h`);

      if (sessions.length === 0) {
        return [];
      }

      const events: NormalizedEventInput[] = sessions.map(sessionToEvent);
      return upsertEvents(db, events);
    },
  };
}
