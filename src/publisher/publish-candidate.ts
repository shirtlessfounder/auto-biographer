import { createCandidatesRepository } from '../db/repositories/candidates-repository';
import type { Queryable } from '../db/pool';
import { findRelevantGitHubRepoUrl, resolvePublicGitHubRepoUrl } from '../github/repo-link';
import type { HermesDrafterPayload } from '../hermes/schemas';
import type { TelegramClient } from '../telegram/client';
import { publishToXViaOAuth } from './x-poster';
import { materializeTelegramPhotoBatch } from './telegram-media';

type PersistedPublishRow = {
  published_post_id: string;
  x_post_id: string | null;
};

type CandidatePublishRow = {
  id: string;
  status: string;
  final_post_text: string | null;
  quote_target_url: string | null;
  media_batch_json: unknown;
  drafter_output_json: unknown;
};

type CandidateRepoSourceRow = {
  source: string;
  url_or_locator: string | null;
  tags: unknown;
  raw_payload: unknown;
};

function parseStoredDrafterPayload(value: unknown): HermesDrafterPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;

  if (
    record.decision !== 'success'
    || record.delivery_kind !== 'single_post'
    || typeof record.draft_text !== 'string'
  ) {
    return null;
  }

  return record as HermesDrafterPayload;
}

async function loadCandidateRepoLinkUrl(db: Queryable, candidateId: string): Promise<string | null> {
  const result = await db.query<CandidateRepoSourceRow>(
    `
      select
        events.source,
        events.url_or_locator,
        events.tags,
        events.raw_payload
      from sp_candidate_sources candidate_sources
      join sp_events events on events.id = candidate_sources.event_id
      where candidate_sources.candidate_id = $1
      order by events.id asc
    `,
    [candidateId],
  );

  return findRelevantGitHubRepoUrl(
    result.rows.map((row) => ({
      source: row.source,
      urlOrLocator: row.url_or_locator,
      tags: row.tags,
      rawPayload: row.raw_payload,
    })),
  );
}

export async function publishCandidate(input: {
  db: Queryable;
  telegramClient: TelegramClient;
  candidateId: string;
  postProfile: string;
  oauthCredentials: {
    consumerKey: string;
    consumerSecret: string;
    accessToken: string;
    accessTokenSecret: string;
  };
  xApiBaseUrl?: string | undefined;
  now?: (() => Date) | undefined;
  publishToX?: typeof publishToXViaOAuth | undefined;
  materializeMediaBatch?: typeof materializeTelegramPhotoBatch | undefined;
  resolvePublicRepoLinkUrl?: typeof resolvePublicGitHubRepoUrl | undefined;
}): Promise<{ outcome: 'published' | 'ignored'; xPostId: string | null }> {
  const now = input.now ?? (() => new Date());
  const candidatesRepository = createCandidatesRepository(input.db);
  const loadedCandidate = await input.db.query<CandidatePublishRow>(
    `
      select id, status, final_post_text, quote_target_url, media_batch_json, drafter_output_json
      from sp_post_candidates
      where id = $1::bigint
    `,
    [input.candidateId],
  );
  console.log(`[publishCandidate] candidate ${input.candidateId}: load query returned ${loadedCandidate.rows.length} rows, candidateRow=${loadedCandidate.rows[0] ? 'FOUND' : 'NULL'}`);
  const candidateRow = loadedCandidate.rows[0] ?? null;

  if (!candidateRow || candidateRow.status !== 'post_requested') {
    console.log(`[publishCandidate] candidate ${input.candidateId}: not post_requested (status=${candidateRow?.status ?? 'NOT_FOUND'}, outcome=ignored)`);
    return {
      outcome: 'ignored',
      xPostId: null,
    };
  }

  const finalPostText = candidateRow.final_post_text;
  console.log(`[publishCandidate] candidate ${input.candidateId}: publishing — text length=${finalPostText?.length ?? 0}`);
  const quoteTargetUrl = candidateRow.quote_target_url;
  const mediaBatchJson = candidateRow.media_batch_json;
  const drafterPayload = parseStoredDrafterPayload(candidateRow.drafter_output_json);
  const publishToX = input.publishToX ?? publishToXViaOAuth;
  const materializeMediaBatch = input.materializeMediaBatch ?? materializeTelegramPhotoBatch;
  const resolvePublicRepoLinkUrl = input.resolvePublicRepoLinkUrl ?? resolvePublicGitHubRepoUrl;

  let cleanup = async () => {};

  try {
    if (!finalPostText || finalPostText.trim().length === 0) {
      throw new Error('Candidate final post text is required');
    }

    const repoLinkUrl =
      quoteTargetUrl === null && drafterPayload?.delivery_kind === 'single_post'
        ? await resolvePublicRepoLinkUrl({
          repoUrl: await loadCandidateRepoLinkUrl(input.db, input.candidateId),
        })
        : null;
    let mediaPaths: string[] = [];

    if (mediaBatchJson) {
      const materialized = await materializeMediaBatch({
        telegramClient: input.telegramClient,
        mediaBatchJson,
      });

      mediaPaths = materialized.mediaPaths;
      cleanup = materialized.cleanup;
    }

    console.log(`[publishCandidate] candidate ${input.candidateId}: calling publishToX...`);

    let published: { tweetId: string; url: string; raw: unknown };
    try {
      published = await publishToX({
        oauthCredentials: input.oauthCredentials,
        text: finalPostText,
        quoteTargetUrl,
        mediaPaths,
        baseUrl: input.xApiBaseUrl,
      });
      console.log(`[publishCandidate] candidate ${input.candidateId}: X post success — tweetId=${published.tweetId}`);
    } catch (err) {
      console.error(`[publishCandidate] candidate ${input.candidateId}: X post FAILED — ${err}`);
      await input.db.query(
        `UPDATE sp_post_candidates SET status = 'post_failed', updated_at = NOW() WHERE id = $1::bigint`,
        [input.candidateId],
      );
      await cleanup();
      return { outcome: 'ignored', xPostId: null };
    }
    const replyPublished = repoLinkUrl
      ? await publishToX({
          oauthCredentials: input.oauthCredentials,
          postProfile: input.postProfile,
          text: repoLinkUrl,
          replyToTweetId: published.tweetId,
          baseUrl: input.xApiBaseUrl,
        })
      : null;
    // Step 1: UPDATE candidate → published
    const updateResult = await input.db.query<{ id: bigint }>(
      `update sp_post_candidates
       set status = 'published', error_details = null, updated_at = now()
       where id = $1::bigint and status = 'post_requested'
       returning id`,
      [input.candidateId],
    );
    console.log(`[publishCandidate] candidate ${input.candidateId}: UPDATE rows affected=${updateResult.rowCount}`);

    if (!updateResult.rows[0]) {
      // Candidate was already processed or status changed — safe to ignore
      console.log(`[publishCandidate] candidate ${input.candidateId}: UPDATE matched 0 rows — already processed or not post_requested`);
      return { outcome: 'ignored', xPostId: null };
    }

    // Step 2: INSERT published_post record
    const insertResult = await input.db.query<PersistedPublishRow>(
      `insert into sp_published_posts (
         candidate_id, posted_at, x_post_id, post_type, final_text,
         quote_target_url, media_attached, publisher_response
       ) values ($1::bigint, now(), $2, $3, $4, $5, $6, $7)
       returning id as published_post_id, x_post_id`,
      [
        input.candidateId,
        published.tweetId,
        quoteTargetUrl ? 'quote_tweet' : replyPublished ? 'thread' : 'tweet',
        finalPostText,
        quoteTargetUrl,
        mediaPaths.length > 0,
        JSON.stringify(replyPublished ? { primary: published.raw, reply: replyPublished.raw } : published.raw),
      ],
    );
    console.log(`[publishCandidate] candidate ${input.candidateId}: INSERT rows=${insertResult.rowCount}`);

    // Step 3: link source usage records
    await input.db.query(
      `insert into sp_source_usage (event_id, artifact_id, published_post_id)
       select event_id, artifact_id, $1
       from sp_candidate_sources where candidate_id = $2::bigint`,
      [insertResult.rows[0].published_post_id, input.candidateId],
    );
    console.log(`[publishCandidate] candidate ${input.candidateId}: INSERT done — rows=${insertResult.rowCount}`);

    await cleanup();

    if (!insertResult.rows[0]) {
      console.log(`[publishCandidate] candidate ${input.candidateId}: result.rows[0] is empty — candidate was likely updated to non-post_requested status by another transaction`);
      return {
        outcome: 'ignored',
        xPostId: null,
      };
    }

    console.log(`[publishCandidate] candidate ${input.candidateId}: DONE — published, xPostId=${insertResult.rows[0].x_post_id}`);
    return {
      outcome: 'published',
      xPostId: insertResult.rows[0].x_post_id,
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
