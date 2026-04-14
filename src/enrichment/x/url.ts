export const X_POST_DOMAINS = ['x.com', 'twitter.com'] as const;

export type XPostDomain = (typeof X_POST_DOMAINS)[number];

export type ParsedXPostUrl = {
  canonicalUrl: string;
  domain: XPostDomain;
  tweetId: string;
  username: string | null;
};

const X_POST_DOMAIN_SET = new Set<string>(X_POST_DOMAINS);

function normalizeHostname(hostname: string): string {
  const lowercased = hostname.toLowerCase();

  return lowercased.startsWith('www.') ? lowercased.slice(4) : lowercased;
}

export function isXPostDomain(domain: string): domain is XPostDomain {
  return X_POST_DOMAIN_SET.has(normalizeHostname(domain));
}

export function parseXPostUrl(value: string): ParsedXPostUrl | null {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const domain = normalizeHostname(url.hostname);

  if (!isXPostDomain(domain)) {
    return null;
  }

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const statusIndex = segments.indexOf('status');
  const tweetId = statusIndex === -1 ? null : segments[statusIndex + 1] ?? null;

  if (tweetId === null || !/^\d+$/.test(tweetId)) {
    return null;
  }

  const username =
    statusIndex === 1 && segments[0] !== undefined && segments[0] !== 'i' ? segments[0] : null;
  const canonicalPath =
    username === null ? `/i/web/status/${tweetId}` : `/${username}/status/${tweetId}`;

  return {
    canonicalUrl: `https://${domain}${canonicalPath}`,
    domain,
    tweetId,
    username,
  };
}
