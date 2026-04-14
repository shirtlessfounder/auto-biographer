import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Pool, PoolClient } from 'pg';

import { upsertEvents as defaultUpsertEvents, type UpsertedNormalizedEvent } from '../normalization/upsert-events';
import type { NormalizedEventInput } from '../normalization/types';

const execFileAsync = promisify(execFile);

type GitHubSourceDb = Pool | PoolClient;

type GitHubSource = {
  sync(): Promise<UpsertedNormalizedEvent[]>;
};

type ExecutorResult = {
  stdout: string;
  stderr: string;
};

type GitHubSourceOptions = {
  githubUsername: string;
  activityLimit?: number;
  executor?: (command: string, args: string[]) => Promise<ExecutorResult>;
  upsertEvents?: (
    db: GitHubSourceDb,
    events: readonly NormalizedEventInput[],
  ) => Promise<UpsertedNormalizedEvent[]>;
};

type GitHubActivityRecord = Record<string, unknown> & {
  id?: unknown;
  type?: unknown;
  created_at?: unknown;
  actor?: unknown;
  repo?: unknown;
  payload?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function getBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseDate(value: unknown): Date | null {
  const dateValue = getString(value);

  if (dateValue === null) {
    return null;
  }

  const date = new Date(dateValue);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseBranchName(ref: string | null): string | null {
  if (ref === null) {
    return null;
  }

  const headPrefix = 'refs/heads/';

  if (ref.startsWith(headPrefix)) {
    return ref.slice(headPrefix.length);
  }

  return ref;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function getRepoName(event: GitHubActivityRecord): string | null {
  if (!isRecord(event.repo)) {
    return null;
  }

  return getString(event.repo.name);
}

function getActorLogin(event: GitHubActivityRecord, fallback: string): string {
  if (!isRecord(event.actor)) {
    return fallback;
  }

  return getString(event.actor.display_login) ?? getString(event.actor.login) ?? fallback;
}

function getEventId(event: GitHubActivityRecord): string | null {
  const stringId = getString(event.id);

  if (stringId !== null) {
    return stringId;
  }

  const numericId = getNumber(event.id);
  return numericId === null ? null : String(numericId);
}

function buildRepoUrl(repoName: string): string {
  return `https://github.com/${repoName}`;
}

function normalizePushEvent(
  event: GitHubActivityRecord,
  repoName: string,
  occurredAt: Date,
  author: string,
): NormalizedEventInput | null {
  if (!isRecord(event.payload)) {
    return null;
  }

  const sourceId = getEventId(event);
  const branch = parseBranchName(getString(event.payload.ref));
  const head = getString(event.payload.head);
  const commits = Array.isArray(event.payload.commits) ? event.payload.commits : [];
  const commitMessages = commits
    .flatMap((commit) => {
      if (!isRecord(commit)) {
        return [];
      }

      const message = getString(commit.message);
      return message === null ? [] : [message];
    });

  if (sourceId === null) {
    return null;
  }

  const url = head === null ? buildRepoUrl(repoName) : `${buildRepoUrl(repoName)}/commit/${head}`;
  const commitCount = commitMessages.length;
  const branchLabel = branch ?? 'unknown branch';
  const summaryBase = `Pushed ${commitCount} ${pluralize(commitCount, 'commit', 'commits')} to ${branchLabel} in ${repoName}`;
  const summary =
    commitMessages.length === 0 ? summaryBase : `${summaryBase}: ${commitMessages.join('; ')}`;
  const tags = [`repo:${repoName}`, 'action:push'];

  if (branch !== null) {
    tags.push(`branch:${branch}`);
  }

  return {
    source: 'github',
    sourceId,
    occurredAt,
    author,
    urlOrLocator: url,
    title: `${repoName} push`,
    summary,
    rawText: commitMessages.length === 0 ? null : commitMessages.join('\n'),
    tags,
    rawPayload: {
      repo: repoName,
      action: 'push',
      url,
      summary,
      branch,
      eventType: event.type,
      event,
    },
  };
}

function normalizePullRequestEvent(
  event: GitHubActivityRecord,
  repoName: string,
  occurredAt: Date,
  author: string,
): NormalizedEventInput | null {
  if (!isRecord(event.payload)) {
    return null;
  }

  const sourceId = getEventId(event);
  const action = getString(event.payload.action);

  if (sourceId === null || action === null || !isRecord(event.payload.pull_request)) {
    return null;
  }

  const pullRequest = event.payload.pull_request;
  const number = getNumber(pullRequest.number);
  const title = getString(pullRequest.title);
  const url = getString(pullRequest.html_url);
  const merged = getBoolean(pullRequest.merged);

  if (number === null || url === null) {
    return null;
  }

  let normalizedAction: 'pr_opened' | 'pr_merged' | 'pr_updated' | null = null;
  let summaryPrefix: string | null = null;

  if (action === 'opened') {
    normalizedAction = 'pr_opened';
    summaryPrefix = 'Opened';
  } else if (action === 'closed' && merged === true) {
    normalizedAction = 'pr_merged';
    summaryPrefix = 'Merged';
  } else if (action === 'synchronize') {
    normalizedAction = 'pr_updated';
    summaryPrefix = 'Updated';
  }

  if (normalizedAction === null || summaryPrefix === null) {
    return null;
  }

  const safeTitle = title ?? `PR #${number}`;
  const summary = `${summaryPrefix} PR #${number} in ${repoName}: ${safeTitle}`;

  return {
    source: 'github',
    sourceId,
    occurredAt,
    author,
    urlOrLocator: url,
    title: safeTitle,
    summary,
    rawText: safeTitle,
    tags: [`repo:${repoName}`, `action:${normalizedAction}`],
    rawPayload: {
      repo: repoName,
      action: normalizedAction,
      url,
      summary,
      pullRequestNumber: number,
      eventType: event.type,
      event,
    },
  };
}

function normalizeWatchEvent(
  event: GitHubActivityRecord,
  repoName: string,
  occurredAt: Date,
  author: string,
): NormalizedEventInput | null {
  if (!isRecord(event.payload)) {
    return null;
  }

  const sourceId = getEventId(event);
  const action = getString(event.payload.action);

  if (sourceId === null || action !== 'started') {
    return null;
  }

  const url = buildRepoUrl(repoName);
  const summary = `Starred ${repoName}`;

  return {
    source: 'github',
    sourceId,
    occurredAt,
    author,
    urlOrLocator: url,
    title: `${repoName} star`,
    summary,
    rawText: summary,
    tags: [`repo:${repoName}`, 'action:starred'],
    rawPayload: {
      repo: repoName,
      action: 'starred',
      url,
      summary,
      eventType: event.type,
      event,
    },
  };
}

function normalizeGitHubEvent(
  event: GitHubActivityRecord,
  githubUsername: string,
): NormalizedEventInput | null {
  const eventType = getString(event.type);
  const repoName = getRepoName(event);
  const occurredAt = parseDate(event.created_at);

  if (eventType === null || repoName === null || occurredAt === null) {
    return null;
  }

  const author = getActorLogin(event, githubUsername);

  if (eventType === 'PushEvent') {
    return normalizePushEvent(event, repoName, occurredAt, author);
  }

  if (eventType === 'PullRequestEvent') {
    return normalizePullRequestEvent(event, repoName, occurredAt, author);
  }

  if (eventType === 'WatchEvent') {
    return normalizeWatchEvent(event, repoName, occurredAt, author);
  }

  return null;
}

function parseActivity(stdout: string): GitHubActivityRecord[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error('gh api did not return valid JSON activity', {
      cause: error,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Error('gh api activity payload must be an array');
  }

  return parsed.filter(isRecord) as GitHubActivityRecord[];
}

async function defaultExecutor(command: string, args: string[]): Promise<ExecutorResult> {
  const result = await execFileAsync(command, args, {
    encoding: 'utf8',
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function createGitHubSource(db: GitHubSourceDb, options: GitHubSourceOptions): GitHubSource {
  const activityLimit = options.activityLimit ?? 100;
  const executor = options.executor ?? defaultExecutor;
  const upsertEvents = options.upsertEvents ?? defaultUpsertEvents;

  return {
    async sync(): Promise<UpsertedNormalizedEvent[]> {
      try {
        await executor('gh', ['auth', 'status']);
      } catch {
        return [];
      }

      const { stdout } = await executor('gh', [
        'api',
        `/users/${options.githubUsername}/events?per_page=${String(activityLimit)}`,
        '--header',
        'Accept: application/vnd.github+json',
      ]);
      const activity = parseActivity(stdout);
      const events = activity
        .map((event) => normalizeGitHubEvent(event, options.githubUsername))
        .filter((event): event is NormalizedEventInput => event !== null);

      if (events.length === 0) {
        return [];
      }

      return upsertEvents(db, events);
    },
  };
}
