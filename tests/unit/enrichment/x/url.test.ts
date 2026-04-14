import { describe, expect, it, vi } from 'vitest';

import type { XThreadLookup, XThreadLookupClient } from '../../../../src/enrichment/x/client';
import { enrichQuoteTarget } from '../../../../src/enrichment/x/enrich-quote-target';
import { parseXPostUrl } from '../../../../src/enrichment/x/url';

function createLookup(): XThreadLookup {
  return {
    targetTweetId: '1912345678901234567',
    conversationId: '1912000000000000000',
    rootTweetId: '1912000000000000000',
    requestedAt: '2026-04-14T17:00:00.000Z',
    via: 'x-api-v2-bearer-token',
    externalUrlExpansion: 'omitted_v1',
    posts: [
      {
        id: '1912000000000000000',
        conversationId: '1912000000000000000',
        createdAt: '2026-04-14T16:30:00.000Z',
        authorId: 'user-1',
        author: {
          id: 'user-1',
          name: 'Dylan Vu',
          username: 'dylanvu',
        },
        text: 'Thread root',
        lang: 'en',
        possiblySensitive: false,
        publicMetrics: {
          bookmarkCount: null,
          impressionCount: null,
          retweetCount: 12,
          replyCount: 3,
          likeCount: 89,
          quoteCount: 1,
        },
        inReplyToUserId: null,
        referencedTweets: [],
        externalUrls: [],
        raw: {
          id: '1912000000000000000',
        },
      },
      {
        id: '1912345678901234567',
        conversationId: '1912000000000000000',
        createdAt: '2026-04-14T16:45:00.000Z',
        authorId: 'user-1',
        author: {
          id: 'user-1',
          name: 'Dylan Vu',
          username: 'dylanvu',
        },
        text: 'Final thought https://t.co/example',
        lang: 'en',
        possiblySensitive: false,
        publicMetrics: {
          bookmarkCount: null,
          impressionCount: null,
          retweetCount: 4,
          replyCount: 2,
          likeCount: 33,
          quoteCount: 0,
        },
        inReplyToUserId: 'user-1',
        referencedTweets: [
          {
            id: '1912000000000000000',
            type: 'replied_to',
          },
        ],
        externalUrls: [
          {
            displayUrl: 'example.com/post',
            expandedUrl: 'https://example.com/post',
            unwoundUrl: null,
            url: 'https://t.co/example',
          },
        ],
        raw: {
          id: '1912345678901234567',
        },
      },
    ],
    rawById: {
      '1912000000000000000': {
        id: '1912000000000000000',
      },
      '1912345678901234567': {
        id: '1912345678901234567',
      },
    },
  };
}

describe('parseXPostUrl', () => {
  it('parses post ids from x.com and twitter.com urls', () => {
    expect(parseXPostUrl('https://x.com/dylanvu/status/1912345678901234567?s=20')).toEqual({
      canonicalUrl: 'https://x.com/dylanvu/status/1912345678901234567',
      domain: 'x.com',
      tweetId: '1912345678901234567',
      username: 'dylanvu',
    });

    expect(parseXPostUrl('https://twitter.com/dylanvu/status/1912345678901234567')).toEqual({
      canonicalUrl: 'https://twitter.com/dylanvu/status/1912345678901234567',
      domain: 'twitter.com',
      tweetId: '1912345678901234567',
      username: 'dylanvu',
    });
  });

  it('returns null for non-status urls', () => {
    expect(parseXPostUrl('https://x.com/home')).toBeNull();
    expect(parseXPostUrl('https://example.com/dylanvu/status/1912345678901234567')).toBeNull();
  });
});

describe('enrichQuoteTarget', () => {
  it('ignores links outside x.com and twitter.com', async () => {
    const client: XThreadLookupClient = {
      lookupThread: vi.fn(),
    };

    await expect(
      enrichQuoteTarget(
        {
          id: 7,
          domain: 'example.com',
          url: 'https://example.com/post',
        },
        client,
      ),
    ).resolves.toBeNull();

    expect(client.lookupThread).not.toHaveBeenCalled();
  });

  it('enriches an x slack_link row into quote-target tweet and thread data', async () => {
    const lookup = createLookup();
    const client: XThreadLookupClient = {
      lookupThread: vi.fn().mockResolvedValue(lookup),
    };

    const result = await enrichQuoteTarget(
      {
        id: 42,
        canonicalUrl: 'https://x.com/dylanvu/status/1912345678901234567?s=20',
        domain: 'x.com',
        url: 'https://x.com/dylanvu/status/1912345678901234567?s=20',
      },
      client,
    );

    expect(client.lookupThread).toHaveBeenCalledWith('1912345678901234567');
    expect(result).toMatchObject({
      artifacts: [
        {
          artifactKey: 'tweet:1912345678901234567:text',
          artifactType: 'quote_target_x_post_text',
          contentText: 'Final thought https://t.co/example',
          sourceUrl: 'https://x.com/dylanvu/status/1912345678901234567',
        },
        {
          artifactKey: 'tweet:1912345678901234567:lookup',
          artifactType: 'quote_target_x_lookup',
          sourceUrl: 'https://x.com/dylanvu/status/1912345678901234567',
        },
        {
          artifactKey: 'conversation:1912000000000000000:thread',
          artifactType: 'quote_target_x_thread',
          sourceUrl: 'https://x.com/dylanvu/status/1912345678901234567',
        },
      ],
      canonicalUrl: 'https://x.com/dylanvu/status/1912345678901234567',
      domain: 'x.com',
      linkId: '42',
      lookup: {
        externalUrlExpansion: 'omitted_v1',
        requestedAt: '2026-04-14T17:00:00.000Z',
        via: 'x-api-v2-bearer-token',
      },
      thread: {
        conversationId: '1912000000000000000',
        postCount: 2,
        rootTweetId: '1912000000000000000',
      },
      tweet: {
        id: '1912345678901234567',
        text: 'Final thought https://t.co/example',
      },
      tweetId: '1912345678901234567',
    });

    const lookupArtifact = result?.artifacts.find(
      (artifact) => artifact.artifactType === 'quote_target_x_lookup',
    );
    const threadArtifact = result?.artifacts.find(
      (artifact) => artifact.artifactType === 'quote_target_x_thread',
    );

    expect(lookupArtifact?.contentJson).toMatchObject({
      externalUrlExpansion: 'omitted_v1',
      sourceLinkId: '42',
      tweetId: '1912345678901234567',
      via: 'x-api-v2-bearer-token',
    });
    expect(threadArtifact?.contentJson).toMatchObject({
      conversationId: '1912000000000000000',
      posts: [
        { id: '1912000000000000000' },
        { id: '1912345678901234567' },
      ],
    });
  });
});
