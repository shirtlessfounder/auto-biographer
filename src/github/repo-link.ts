type RepoLinkCarrier = {
  rawPayload?: unknown;
  sourceUrl?: string | null | undefined;
  tags?: unknown;
  urlOrLocator?: string | null | undefined;
};

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'json' | 'ok'>>;

function getString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRepoName(value: string): string | null {
  const trimmed = value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/^\/+/, '');
  const segments = trimmed.split('/').filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    return null;
  }

  return `${segments[0]}/${segments[1]}`;
}

function repoNameFromUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);

    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
      return null;
    }

    return normalizeRepoName(parsed.pathname);
  } catch {
    return null;
  }
}

function repoNameFromRawPayload(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  return normalizeRepoName(getString(record.repo) ?? '') ?? repoNameFromUrl(getString(record.url));
}

function repoNameFromTags(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  for (const tag of value) {
    const text = getString(tag);

    if (text?.startsWith('repo:')) {
      return normalizeRepoName(text.slice('repo:'.length));
    }
  }

  return null;
}

function buildRepoUrl(repoName: string): string {
  return `https://github.com/${repoName}`;
}

function getGitHubToken(): string | null {
  return getString(process.env.GITHUB_TOKEN) ?? getString(process.env.GH_TOKEN);
}

export function extractGitHubRepoUrl(input: RepoLinkCarrier): string | null {
  const repoName =
    repoNameFromRawPayload(input.rawPayload)
    ?? repoNameFromTags(input.tags)
    ?? repoNameFromUrl(input.urlOrLocator)
    ?? repoNameFromUrl(input.sourceUrl);

  return repoName ? buildRepoUrl(repoName) : null;
}

export function findRelevantGitHubRepoUrl(inputs: readonly RepoLinkCarrier[]): string | null {
  for (const input of inputs) {
    const repoUrl = extractGitHubRepoUrl(input);

    if (repoUrl) {
      return repoUrl;
    }
  }

  return null;
}

export async function resolvePublicGitHubRepoUrl(input: {
  repoUrl: string | null | undefined;
  fetchFn?: FetchLike | undefined;
  token?: string | null | undefined;
}): Promise<string | null> {
  const repoUrl = getString(input.repoUrl);

  if (repoUrl === null) {
    return null;
  }

  const repoName = repoNameFromUrl(repoUrl);

  if (repoName === null) {
    return null;
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'auto-biographer',
  };
  const token = getString(input.token) ?? getGitHubToken();

  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const fetchFn = input.fetchFn ?? fetch;
    const response = await fetchFn(`https://api.github.com/repos/${repoName}`, { headers });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();

    if (
      typeof payload !== 'object'
      || payload === null
      || Array.isArray(payload)
      || !('private' in payload)
      || payload.private !== false
    ) {
      return null;
    }

    return buildRepoUrl(repoName);
  } catch {
    return null;
  }
}
