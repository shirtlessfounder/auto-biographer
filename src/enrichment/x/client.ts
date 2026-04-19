import { z } from 'zod';

const X_POST_REFERENCE_TYPES = ['quoted', 'replied_to', 'retweeted'] as const;
const DEFAULT_THREAD_DEPTH = 8;

const XApiUserSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  username: z.string().nullish(),
});

const XApiUrlEntitySchema = z.object({
  display_url: z.string().nullish(),
  expanded_url: z.string().nullish(),
  unwound_url: z.string().nullish(),
  url: z.string(),
});

const XApiPostSchema = z.object({
  author_id: z.string().nullish(),
  conversation_id: z.string().nullish(),
  created_at: z.string().nullish(),
  entities: z
    .object({
      urls: z.array(XApiUrlEntitySchema).nullish(),
    })
    .nullish(),
  id: z.string(),
  in_reply_to_user_id: z.string().nullish(),
  lang: z.string().nullish(),
  note_tweet: z
    .object({
      text: z.string(),
    })
    .nullish(),
  possibly_sensitive: z.boolean().nullish(),
  public_metrics: z
    .object({
      bookmark_count: z.number().int().nonnegative().nullish(),
      impression_count: z.number().int().nonnegative().nullish(),
      like_count: z.number().int().nonnegative().nullish(),
      quote_count: z.number().int().nonnegative().nullish(),
      reply_count: z.number().int().nonnegative().nullish(),
      retweet_count: z.number().int().nonnegative().nullish(),
    })
    .nullish(),
  referenced_tweets: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(X_POST_REFERENCE_TYPES),
      }),
    )
    .nullish(),
  text: z.string(),
});

const XApiLookupResponseSchema = z.object({
  data: XApiPostSchema,
  includes: z
    .object({
      tweets: z.array(XApiPostSchema).optional(),
      users: z.array(XApiUserSchema).optional(),
    })
    .optional(),
});

export type XPostReferenceType = (typeof X_POST_REFERENCE_TYPES)[number];

export type XUser = {
  id: string;
  name: string | null;
  username: string | null;
};

export type XPostReference = {
  id: string;
  type: XPostReferenceType;
};

export type XExternalUrl = {
  displayUrl: string | null;
  expandedUrl: string | null;
  unwoundUrl: string | null;
  url: string;
};

export type XPublicMetrics = {
  bookmarkCount: number | null;
  impressionCount: number | null;
  likeCount: number | null;
  quoteCount: number | null;
  replyCount: number | null;
  retweetCount: number | null;
};

export type XPost = {
  author: XUser | null;
  authorId: string | null;
  conversationId: string;
  createdAt: string | null;
  externalUrls: XExternalUrl[];
  id: string;
  inReplyToUserId: string | null;
  lang: string | null;
  possiblySensitive: boolean | null;
  publicMetrics: XPublicMetrics | null;
  raw: unknown;
  referencedTweets: XPostReference[];
  text: string;
};

export type XThreadLookup = {
  conversationId: string;
  externalUrlExpansion: 'omitted_v1';
  posts: XPost[];
  rawById: Record<string, unknown>;
  requestedAt: string;
  rootTweetId: string;
  targetTweetId: string;
  via: 'x-api-v2-bearer-token';
};

export type XThreadLookupClient = {
  lookupThread(tweetId: string): Promise<XThreadLookup>;
};

type XApiLookupResponse = z.infer<typeof XApiLookupResponseSchema>;
type XApiPost = z.infer<typeof XApiPostSchema>;
type FetchImplementation = typeof fetch;

type XClientOptions = {
  baseUrl?: string;
  bearerToken?: string;
  fetchImpl?: FetchImplementation;
  maxThreadDepth?: number;
  now?: () => Date;
};

type XFetchResult = {
  rawById: Record<string, unknown>;
};

function mapPublicMetrics(
  publicMetrics: XApiPost['public_metrics'] | null | undefined,
): XPublicMetrics | null {
  if (publicMetrics == null) {
    return null;
  }

  return {
    bookmarkCount: publicMetrics.bookmark_count ?? null,
    impressionCount: publicMetrics.impression_count ?? null,
    likeCount: publicMetrics.like_count ?? null,
    quoteCount: publicMetrics.quote_count ?? null,
    replyCount: publicMetrics.reply_count ?? null,
    retweetCount: publicMetrics.retweet_count ?? null,
  };
}

function mapPost(
  post: XApiPost,
  usersById: Map<string, XUser>,
  raw: unknown,
): XPost {
  return {
    author: post.author_id == null ? null : usersById.get(post.author_id) ?? null,
    authorId: post.author_id ?? null,
    conversationId: post.conversation_id ?? post.id,
    createdAt: post.created_at ?? null,
    externalUrls: (post.entities?.urls ?? []).map((url) => ({
      displayUrl: url.display_url ?? null,
      expandedUrl: url.expanded_url ?? null,
      unwoundUrl: url.unwound_url ?? null,
      url: url.url,
    })),
    id: post.id,
    inReplyToUserId: post.in_reply_to_user_id ?? null,
    lang: post.lang ?? null,
    possiblySensitive: post.possibly_sensitive ?? null,
    publicMetrics: mapPublicMetrics(post.public_metrics),
    raw,
    referencedTweets: (post.referenced_tweets ?? []).map((reference) => ({
      id: reference.id,
      type: reference.type,
    })),
    text: post.note_tweet?.text ?? post.text,
  };
}

function buildLookupUrl(baseUrl: string, tweetId: string): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const searchParams = new URLSearchParams({
    expansions: 'author_id,referenced_tweets.id,referenced_tweets.id.author_id',
    'tweet.fields':
      'author_id,conversation_id,created_at,entities,in_reply_to_user_id,lang,note_tweet,possibly_sensitive,public_metrics,referenced_tweets',
    'user.fields': 'name,username',
  });

  return `${normalizedBaseUrl}/tweets/${tweetId}?${searchParams.toString()}`;
}

function mergeLookupResponse(
  parsedResponse: XApiLookupResponse,
  postCache: Map<string, XPost>,
  rawById: Record<string, unknown>,
): void {
  const usersById = new Map<string, XUser>();

  for (const user of parsedResponse.includes?.users ?? []) {
    usersById.set(user.id, {
      id: user.id,
      name: user.name ?? null,
      username: user.username ?? null,
    });
  }

  const posts = [parsedResponse.data, ...(parsedResponse.includes?.tweets ?? [])];

  for (const post of posts) {
    rawById[post.id] = post;
    postCache.set(post.id, mapPost(post, usersById, post));
  }
}

async function fetchAndCachePost(
  tweetId: string,
  options: Required<Pick<XClientOptions, 'baseUrl' | 'fetchImpl'>> & { bearerToken?: string },
  postCache: Map<string, XPost>,
  rawById: Record<string, unknown>,
): Promise<XFetchResult> {
  const response = await options.fetchImpl(buildLookupUrl(options.baseUrl, tweetId), {
    headers: {},
  });

  if (!response.ok) {
    const errorBody = await response.text();

    throw new Error(
      `X lookup failed for tweet ${tweetId}: ${response.status} ${response.statusText} ${errorBody}`.trim(),
    );
  }

  const parsedResponse = XApiLookupResponseSchema.parse(await response.json());
  mergeLookupResponse(parsedResponse, postCache, rawById);

  return {
    rawById,
  };
}

export function createXClient(options: XClientOptions): XThreadLookupClient {
  const baseUrl = options.baseUrl ?? 'https://api.x.com/2';
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxThreadDepth = options.maxThreadDepth ?? DEFAULT_THREAD_DEPTH;
  const now = options.now ?? (() => new Date());

  return {
    async lookupThread(tweetId: string): Promise<XThreadLookup> {
      const postCache = new Map<string, XPost>();
      const rawById: Record<string, unknown> = {};
      const visitedPostIds = new Set<string>();

      await fetchAndCachePost(
        tweetId,
        {
          baseUrl,
          bearerToken: options.bearerToken,
          fetchImpl,
        },
        postCache,
        rawById,
      );

      const threadPosts: XPost[] = [];
      let currentPost = postCache.get(tweetId);

      if (currentPost === undefined) {
        throw new Error(`X lookup returned no tweet for ${tweetId}`);
      }

      for (let depth = 0; depth < maxThreadDepth; depth += 1) {
        if (visitedPostIds.has(currentPost.id)) {
          break;
        }

        visitedPostIds.add(currentPost.id);
        threadPosts.unshift(currentPost);

        const parentTweetId = currentPost.referencedTweets.find(
          (reference) => reference.type === 'replied_to',
        )?.id;

        if (parentTweetId === undefined) {
          break;
        }

        if (!postCache.has(parentTweetId)) {
          await fetchAndCachePost(
            parentTweetId,
            {
              baseUrl,
              bearerToken: options.bearerToken,
              fetchImpl,
            },
            postCache,
            rawById,
          );
        }

        currentPost = postCache.get(parentTweetId);

        if (currentPost === undefined) {
          throw new Error(`X lookup returned no tweet for parent ${parentTweetId}`);
        }
      }

      const rootPost = threadPosts[0];
      const targetPost = threadPosts[threadPosts.length - 1];

      if (rootPost === undefined || targetPost === undefined) {
        throw new Error(`X lookup returned an empty thread for ${tweetId}`);
      }

      return {
        conversationId: targetPost.conversationId,
        externalUrlExpansion: 'omitted_v1',
        posts: threadPosts,
        rawById,
        requestedAt: now().toISOString(),
        rootTweetId: rootPost.id,
        targetTweetId: targetPost.id,
        via: 'x-api-v2-bearer-token',
      };
    },
  };
}
