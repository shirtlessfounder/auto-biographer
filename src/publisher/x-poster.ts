import crypto from 'crypto';

type XOAuthCredentials = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

type PostResult = {
  tweetId: string;
  url: string;
  raw: unknown;
};

type XPosterOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

function percentEncode(str: string): string {
  // EncodeURIComponent but handle tilde and other chars that OAuth 1.0a requires encoded
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuthSignature({
  url,
  method,
  oauthParams,
  consumerSecret,
  tokenSecret,
}: {
  url: string;
  method: string;
  oauthParams: Record<string, string>;
  consumerSecret: string;
  tokenSecret: string;
}): string {
  const sortedParams = Object.keys(oauthParams).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join('&');
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedParams),
  ].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

function buildAuthHeader({
  url,
  method,
  credentials,
  bodyParams = {},
}: {
  url: string;
  method: string;
  credentials: XOAuthCredentials;
  bodyParams?: Record<string, string>;
}): string {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = generateNonce();

  const oauthParams: Record<string, string> = {
    ...bodyParams,
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };

  // Include OAuth params in signature (except oauth_signature itself)
  const signature = buildOAuthSignature({
    url,
    method,
    oauthParams,
    consumerSecret: credentials.consumerSecret,
    tokenSecret: credentials.accessTokenSecret,
  });

  oauthParams.oauth_signature = signature;

  const authParts = Object.entries(oauthParams)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ');

  return `OAuth ${authParts}`;
}

async function postTweetRequest(
  text: string,
  options: {
    credentials: XOAuthCredentials;
    url: string;
    replyTo?: string | null;
    quote?: string | null;
    fetchImpl: typeof fetch;
  },
): Promise<Response> {
  const { credentials, url, replyTo, quote, fetchImpl } = options;

  const body: Record<string, unknown> = { text };

  if (replyTo) {
    body.reply = { in_reply_to_tweet_id: replyTo };
  }

  if (quote) {
    body.quote_tweet_id = quote;
  }
  const method = 'POST';
  const bodyString = JSON.stringify(body);

  const authHeader = buildAuthHeader({
    url,
    method,
    credentials,
  });

  return fetchImpl(url, {
    method,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: bodyString,
  });
}

export function createXXPoster(credentials: XOAuthCredentials, options: XPosterOptions = {}): {
  postTweet(input: {
    text: string;
    replyToTweetId?: string | null | undefined;
    quoteTargetTweetId?: string | null | undefined;
  }): Promise<PostResult>;
} {
  const baseUrl = options.baseUrl ?? 'https://api.x.com/2';
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async postTweet(input: {
      text: string;
      replyToTweetId?: string | null | undefined;
      quoteTargetTweetId?: string | null | undefined;
    }): Promise<PostResult> {
      const url = `${baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl}/tweets`;

      const response = await postTweetRequest(input.text, {
        credentials,
        url,
        replyTo: input.replyToTweetId,
        quote: input.quoteTargetTweetId,
        fetchImpl,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`X post failed: ${response.status} ${response.statusText} — ${errorBody}`);
      }

      const json = await response.json() as { data?: { id?: string; text?: string }; errors?: Array<{ detail?: string }> };

      if (!json.data?.id) {
        const msg = json.errors?.[0]?.detail ?? JSON.stringify(json);
        throw new Error(`X post returned no tweet ID: ${msg}`);
      }

      const tweetId = json.data.id;

      return {
        tweetId,
        url: `https://x.com/i/status/${tweetId}`,
        raw: json,
      };
    },
  };
}

// Adapter: makes createXXPoster look like the publishToX interface expected by publish-candidate
export async function publishToXViaOAuth(input: {
  oauthCredentials: XOAuthCredentials;
  postProfile: string;
  text: string;
  quoteTargetUrl?: string | null | undefined;
  replyToTweetId?: string | null | undefined;
  mediaPaths?: readonly string[] | undefined;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ tweetId: string; url: string; raw: unknown }> {
  if (input.mediaPaths && input.mediaPaths.length > 0) {
    throw new Error('Media upload via OAuth not yet implemented');
  }

  const poster = createXXPoster(input.oauthCredentials, {
    baseUrl: 'https://api.x.com/2',
    fetchImpl: input.fetchImpl,
  });

  let quoteTargetTweetId: string | null | undefined;
  if (input.quoteTargetUrl) {
    const { parseXPostUrl } = await import('../enrichment/x/url');
    const parsed = parseXPostUrl(input.quoteTargetUrl);
    if (!parsed) {
      throw new Error(`Invalid X quote target URL: ${input.quoteTargetUrl}`);
    }
    quoteTargetTweetId = parsed.tweetId;
  }

  return poster.postTweet({
    text: input.text,
    replyToTweetId: input.replyToTweetId,
    quoteTargetTweetId,
  });
}
