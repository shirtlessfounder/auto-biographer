import { createCandidatesRepository } from '../db/repositories/candidates-repository';
import type { Queryable } from '../db/pool';
import type { TelegramClient } from '../telegram/client';
import { publishToXViaScript } from './x-command';
import { materializeTelegramPhotoBatch } from './telegram-media';

type PersistedPublishRow = {
  published_post_id: string;
  x_post_id: string | null;
};

export async function publishCandidate(input: {
  db: Queryable;
  telegramClient: TelegramClient;
  candidateId: string;
  postProfile: string;
  clawdTweetScript: string;
  now?: (() => Date) | undefined;
  publishToX?: typeof publishToXViaScript | undefined;
  materializeMediaBatch?: typeof materializeTelegramPhotoBatch | undefined;
}): Promise<{ outcome: 'published' | 'ignored'; xPostId: string | null }> {
  const now = input.now ?? (() => new Date());
  const candidatesRepository = createCandidatesRepository(input.db);
  const loadedCandidate = await input.db.query<{
    id: string;
    status: string;
    final_post_text: string | null;
    quote_target_url: string | null;
    media_batch_json: unknown;
  }>(
    `
      select id, status, final_post_text, quote_target_url, media_batch_json
      from sp_post_candidates
      where id = $1
    `,
    [input.candidateId],
  );
  const candidateRow = loadedCandidate.rows[0] ?? null;

  if (!candidateRow || candidateRow.status !== 'post_requested') {
    return {
      outcome: 'ignored',
      xPostId: null,
    };
  }

  const finalPostText = candidateRow.final_post_text;
  const quoteTargetUrl = candidateRow.quote_target_url;
  const mediaBatchJson = candidateRow.media_batch_json;
  const publishToX = input.publishToX ?? publishToXViaScript;
  const materializeMediaBatch = input.materializeMediaBatch ?? materializeTelegramPhotoBatch;

  let cleanup = async () => {};

  try {
    if (!finalPostText || finalPostText.trim().length === 0) {
      throw new Error('Candidate final post text is required');
    }

    let mediaPaths: string[] = [];

    if (mediaBatchJson) {
      const materialized = await materializeMediaBatch({
        telegramClient: input.telegramClient,
        mediaBatchJson,
      });

      mediaPaths = materialized.mediaPaths;
      cleanup = materialized.cleanup;
    }

    const published = await publishToX({
      clawdTweetScript: input.clawdTweetScript,
      postProfile: input.postProfile,
      text: finalPostText,
      quoteTargetUrl,
      mediaPaths,
    });
    const result = await input.db.query<PersistedPublishRow>(
      `
        with updated_candidate as (
          update sp_post_candidates
          set status = 'published',
              error_details = null,
              updated_at = now()
          where id = $1
            and status = 'post_requested'
          returning id
        ),
        inserted_post as (
          insert into sp_published_posts (
            candidate_id,
            posted_at,
            x_post_id,
            post_type,
            final_text,
            quote_target_url,
            media_attached,
            publisher_response
          )
          select
            $1::bigint,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8
          from updated_candidate
          returning id, x_post_id
        ),
        inserted_usage as (
          insert into sp_source_usage (event_id, artifact_id, published_post_id)
          select candidate_sources.event_id, candidate_sources.artifact_id, inserted_post.id
          from sp_candidate_sources candidate_sources
          cross join inserted_post
          where candidate_sources.candidate_id = $1
          returning 1
        )
        select id as published_post_id, x_post_id
        from inserted_post
      `,
      [
        input.candidateId,
        now(),
        published.tweetId,
        quoteTargetUrl ? 'quote_tweet' : 'tweet',
        finalPostText,
        quoteTargetUrl,
        mediaPaths.length > 0,
        JSON.stringify(published.raw),
      ],
    );

    await cleanup();

    if (!result.rows[0]) {
      return {
        outcome: 'ignored',
        xPostId: null,
      };
    }

    return {
      outcome: 'published',
      xPostId: result.rows[0].x_post_id,
    };
  } catch (error) {
    await cleanup();

    const message = error instanceof Error ? error.message : String(error);

    await candidatesRepository.transitionStatus({
      id: input.candidateId,
      fromStatuses: ['post_requested'],
      toStatus: 'delivery_failed',
      errorDetails: message,
    });

    try {
      await input.telegramClient.sendMessage({
        text: `X publish failed for candidate #${input.candidateId}: ${message}`,
      });
    } catch {
      // Preserve the original publish failure.
    }

    return {
      outcome: 'ignored',
      xPostId: null,
    };
  }
}
