import type { Queryable } from '../pool';

export type PublishedPostRecord = {
  id: string;
  candidateId: string;
  postedAt: Date;
  xPostId: string | null;
  postType: string;
  finalText: string;
  quoteTargetUrl: string | null;
  mediaAttached: boolean;
  publisherResponse: unknown;
  createdAt: Date;
};

export type InsertPublishedPostInput = {
  candidateId: string;
  postedAt: Date;
  xPostId?: string | null | undefined;
  postType: string;
  finalText: string;
  quoteTargetUrl?: string | null | undefined;
  mediaAttached?: boolean | undefined;
  publisherResponse?: unknown;
};

type PublishedPostRow = {
  id: string;
  candidate_id: string;
  posted_at: Date;
  x_post_id: string | null;
  post_type: string;
  final_text: string;
  quote_target_url: string | null;
  media_attached: boolean;
  publisher_response: unknown;
  created_at: Date;
};

function toJsonbValue(value: unknown): string {
  return JSON.stringify(value);
}

function mapPublishedPostRow(row: PublishedPostRow): PublishedPostRecord {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    postedAt: row.posted_at,
    xPostId: row.x_post_id,
    postType: row.post_type,
    finalText: row.final_text,
    quoteTargetUrl: row.quote_target_url,
    mediaAttached: row.media_attached,
    publisherResponse: row.publisher_response,
    createdAt: row.created_at,
  };
}

export function createPublishedPostsRepository(db: Queryable) {
  return {
    async insertPublishedPost(input: InsertPublishedPostInput): Promise<PublishedPostRecord> {
      const result = await db.query<PublishedPostRow>(
        `
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
          values ($1, $2, $3, $4, $5, $6, $7, $8)
          returning
            id,
            candidate_id,
            posted_at,
            x_post_id,
            post_type,
            final_text,
            quote_target_url,
            media_attached,
            publisher_response,
            created_at
        `,
        [
          input.candidateId,
          input.postedAt,
          input.xPostId ?? null,
          input.postType,
          input.finalText,
          input.quoteTargetUrl ?? null,
          input.mediaAttached ?? false,
          toJsonbValue(input.publisherResponse ?? null),
        ],
      );

      const row = result.rows[0];

      if (!row) {
        throw new Error('Published post insert did not return a row');
      }

      return mapPublishedPostRow(row);
    },
  };
}
