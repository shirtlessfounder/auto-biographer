import crypto from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';

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

// ── Media upload (Twitter v1.1 /media/upload.json) ───────────────────────────

const MEDIA_UPLOAD_URL = 'https://upload.twitter.com/1.1/media/upload.json';

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  throw new Error(`Unsupported media extension for OAuth upload: ${ext || '<none>'}`);
}

// Form-encoded POST with OAuth1 — body params included in signature base string.
async function oauthFormPost(
  url: string,
  form: Record<string, string>,
  credentials: XOAuthCredentials,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const authHeader = buildAuthHeader({
    url,
    method: 'POST',
    credentials,
    bodyParams: form,
  });
  const body = Object.entries(form)
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join('&');
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

// Multipart/form-data POST with OAuth1 — body params NOT included in signature
// base (per Twitter/OAuth1 spec for non-urlencoded bodies). Manual multipart
// construction keeps this dependency-free.
async function oauthMultipartPost(
  url: string,
  fields: Record<string, string>,
  file: { field: string; filename: string; mimeType: string; bytes: Buffer },
  credentials: XOAuthCredentials,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const authHeader = buildAuthHeader({
    url,
    method: 'POST',
    credentials,
    // Deliberately no bodyParams — multipart bodies are excluded from signing.
  });
  const boundary = `----autobiog${crypto.randomBytes(12).toString('hex')}`;
  const CRLF = '\r\n';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}` +
      `${v}${CRLF}`,
      'utf8',
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"${CRLF}` +
    `Content-Type: ${file.mimeType}${CRLF}${CRLF}`,
    'utf8',
  ));
  parts.push(file.bytes);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8'));
  const body = Buffer.concat(parts);
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
}

async function uploadMediaFile(input: {
  filePath: string;
  credentials: XOAuthCredentials;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const bytes = await readFile(input.filePath);
  const mimeType = mimeTypeForPath(input.filePath);
  const filename = path.basename(input.filePath);

  // INIT
  const initResp = await oauthFormPost(
    MEDIA_UPLOAD_URL,
    {
      command: 'INIT',
      total_bytes: String(bytes.length),
      media_type: mimeType,
      media_category: 'tweet_image',
    },
    input.credentials,
    input.fetchImpl,
  );
  if (!initResp.ok) {
    const errorBody = await initResp.text();
    throw new Error(`media/upload INIT failed: ${initResp.status} — ${errorBody}`);
  }
  const initJson = await initResp.json() as { media_id_string?: string };
  const mediaId = initJson.media_id_string;
  if (!mediaId) {
    throw new Error(`media/upload INIT returned no media_id_string: ${JSON.stringify(initJson)}`);
  }

  // APPEND (single chunk — fine for photos up to 5 MB)
  const appendResp = await oauthMultipartPost(
    MEDIA_UPLOAD_URL,
    {
      command: 'APPEND',
      media_id: mediaId,
      segment_index: '0',
    },
    { field: 'media', filename, mimeType, bytes },
    input.credentials,
    input.fetchImpl,
  );
  if (!appendResp.ok) {
    const errorBody = await appendResp.text();
    throw new Error(`media/upload APPEND failed: ${appendResp.status} — ${errorBody}`);
  }

  // FINALIZE
  const finalizeResp = await oauthFormPost(
    MEDIA_UPLOAD_URL,
    { command: 'FINALIZE', media_id: mediaId },
    input.credentials,
    input.fetchImpl,
  );
  if (!finalizeResp.ok) {
    const errorBody = await finalizeResp.text();
    throw new Error(`media/upload FINALIZE failed: ${finalizeResp.status} — ${errorBody}`);
  }
  const finalizeJson = await finalizeResp.json() as {
    media_id_string?: string;
    processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } };
  };

  // For images, processing_info is usually absent. Poll STATUS if present.
  if (finalizeJson.processing_info?.state && finalizeJson.processing_info.state !== 'succeeded') {
    await waitForMediaReady({
      mediaId,
      credentials: input.credentials,
      fetchImpl: input.fetchImpl,
      initialDelaySecs: finalizeJson.processing_info.check_after_secs ?? 1,
    });
  }

  return mediaId;
}

async function waitForMediaReady(input: {
  mediaId: string;
  credentials: XOAuthCredentials;
  fetchImpl: typeof fetch;
  initialDelaySecs: number;
}): Promise<void> {
  let delay = Math.max(1, input.initialDelaySecs);
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, delay * 1000));
    const statusUrl = `${MEDIA_UPLOAD_URL}?command=STATUS&media_id=${input.mediaId}`;
    const authHeader = buildAuthHeader({
      url: MEDIA_UPLOAD_URL,
      method: 'GET',
      credentials: input.credentials,
      bodyParams: { command: 'STATUS', media_id: input.mediaId },
    });
    const resp = await input.fetchImpl(statusUrl, {
      method: 'GET',
      headers: { Authorization: authHeader },
    });
    if (!resp.ok) {
      const errorBody = await resp.text();
      throw new Error(`media/upload STATUS failed: ${resp.status} — ${errorBody}`);
    }
    const json = await resp.json() as {
      processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } };
    };
    const state = json.processing_info?.state;
    if (state === 'succeeded' || !state) return;
    if (state === 'failed') {
      throw new Error(`media processing failed: ${json.processing_info?.error?.message ?? 'unknown'}`);
    }
    delay = json.processing_info?.check_after_secs ?? Math.min(delay * 2, 10);
  }
  throw new Error(`media processing timed out for media_id ${input.mediaId}`);
}

// ── Tweet creation ───────────────────────────────────────────────────────────

async function postTweetRequest(
  text: string,
  options: {
    credentials: XOAuthCredentials;
    url: string;
    replyTo?: string | null | undefined;
    quote?: string | null | undefined;
    mediaIds?: readonly string[] | undefined;
    fetchImpl: typeof fetch;
  },
): Promise<Response> {
  const { credentials, url, replyTo, quote, mediaIds, fetchImpl } = options;

  const body: Record<string, unknown> = { text };

  if (replyTo) {
    body.reply = { in_reply_to_tweet_id: replyTo };
  }

  if (quote) {
    body.quote_tweet_id = quote;
  }

  if (mediaIds && mediaIds.length > 0) {
    body.media = { media_ids: mediaIds };
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
    mediaIds?: readonly string[] | undefined;
  }): Promise<PostResult>;
} {
  const baseUrl = options.baseUrl ?? 'https://api.x.com/2';
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async postTweet(input: {
      text: string;
      replyToTweetId?: string | null | undefined;
      quoteTargetTweetId?: string | null | undefined;
      mediaIds?: readonly string[] | undefined;
    }): Promise<PostResult> {
      const url = `${baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl}/tweets`;

      const response = await postTweetRequest(input.text, {
        credentials,
        url,
        replyTo: input.replyToTweetId,
        quote: input.quoteTargetTweetId,
        mediaIds: input.mediaIds,
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
  const fetchImpl = input.fetchImpl ?? fetch;

  // Upload each media file via v1.1 INIT/APPEND/FINALIZE, collect media_ids.
  const mediaIds: string[] = [];
  for (const filePath of input.mediaPaths ?? []) {
    const mediaId = await uploadMediaFile({
      filePath,
      credentials: input.oauthCredentials,
      fetchImpl,
    });
    mediaIds.push(mediaId);
  }

  const poster = createXXPoster(input.oauthCredentials, {
    baseUrl: 'https://api.x.com/2',
    fetchImpl,
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
    mediaIds: mediaIds.length > 0 ? mediaIds : undefined,
  });
}
