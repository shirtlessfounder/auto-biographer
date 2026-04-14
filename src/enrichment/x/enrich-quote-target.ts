import type { XPost, XThreadLookupClient } from './client';
import { isXPostDomain, parseXPostUrl, type XPostDomain } from './url';

export type QuoteTargetArtifact = {
  artifactKey: string;
  artifactType: 'quote_target_x_post_text' | 'quote_target_x_lookup' | 'quote_target_x_thread';
  contentJson: unknown;
  contentText: string | null;
  sourceUrl: string | null;
};

export type SlackLinkQuoteTargetCandidate = {
  canonicalUrl?: string | null;
  domain: string;
  finalUrl?: string | null;
  id: number | string;
  url: string;
};

export type EnrichedQuoteTarget = {
  artifacts: QuoteTargetArtifact[];
  canonicalUrl: string;
  domain: XPostDomain;
  linkId: string;
  lookup: {
    externalUrlExpansion: 'omitted_v1';
    requestedAt: string;
    via: 'x-api-v2-bearer-token';
  };
  thread: {
    conversationId: string;
    postCount: number;
    posts: XPost[];
    rootTweetId: string;
  };
  tweet: XPost;
  tweetId: string;
  url: string;
};

function resolveLinkUrl(candidate: SlackLinkQuoteTargetCandidate): string {
  return candidate.finalUrl ?? candidate.canonicalUrl ?? candidate.url;
}

function buildArtifacts(
  candidate: SlackLinkQuoteTargetCandidate,
  canonicalUrl: string,
  tweetId: string,
  tweet: XPost,
  threadPosts: XPost[],
  threadConversationId: string,
  lookup: EnrichedQuoteTarget['lookup'],
): QuoteTargetArtifact[] {
  return [
    {
      artifactKey: `tweet:${tweetId}:text`,
      artifactType: 'quote_target_x_post_text',
      contentJson: null,
      contentText: tweet.text,
      sourceUrl: canonicalUrl,
    },
    {
      artifactKey: `tweet:${tweetId}:lookup`,
      artifactType: 'quote_target_x_lookup',
      contentJson: {
        canonicalUrl,
        externalUrlExpansion: lookup.externalUrlExpansion,
        requestedAt: lookup.requestedAt,
        sourceLinkId: String(candidate.id),
        sourceUrl: candidate.url,
        tweet,
        tweetId,
        via: lookup.via,
      },
      contentText: null,
      sourceUrl: canonicalUrl,
    },
    {
      artifactKey: `conversation:${threadConversationId}:thread`,
      artifactType: 'quote_target_x_thread',
      contentJson: {
        conversationId: threadConversationId,
        posts: threadPosts,
        rootTweetId: threadPosts[0]?.id ?? tweetId,
      },
      contentText: null,
      sourceUrl: canonicalUrl,
    },
  ];
}

export async function enrichQuoteTarget(
  candidate: SlackLinkQuoteTargetCandidate,
  client: XThreadLookupClient,
): Promise<EnrichedQuoteTarget | null> {
  if (!isXPostDomain(candidate.domain)) {
    return null;
  }

  const parsedUrl = parseXPostUrl(resolveLinkUrl(candidate));

  if (parsedUrl === null) {
    return null;
  }

  const lookup = await client.lookupThread(parsedUrl.tweetId);
  const tweet = lookup.posts[lookup.posts.length - 1];

  if (tweet === undefined) {
    throw new Error(`X lookup returned an empty thread for ${parsedUrl.tweetId}`);
  }

  if (tweet.id !== parsedUrl.tweetId) {
    throw new Error(
      `X lookup target mismatch: expected ${parsedUrl.tweetId}, received ${tweet.id}`,
    );
  }

  const lookupMetadata = {
    externalUrlExpansion: lookup.externalUrlExpansion,
    requestedAt: lookup.requestedAt,
    via: lookup.via,
  } as const;

  return {
    artifacts: buildArtifacts(
      candidate,
      parsedUrl.canonicalUrl,
      parsedUrl.tweetId,
      tweet,
      lookup.posts,
      lookup.conversationId,
      lookupMetadata,
    ),
    canonicalUrl: parsedUrl.canonicalUrl,
    domain: parsedUrl.domain,
    linkId: String(candidate.id),
    lookup: lookupMetadata,
    thread: {
      conversationId: lookup.conversationId,
      postCount: lookup.posts.length,
      posts: lookup.posts,
      rootTweetId: lookup.rootTweetId,
    },
    tweet,
    tweetId: parsedUrl.tweetId,
    url: candidate.url,
  };
}
