# X Publisher V1 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish approved X candidates immediately from `tick`, including optional Telegram photo replies, and record publish/source-usage state end to end.

**Architecture:** Keep `tick` as the only orchestrator entrypoint, but add a dedicated publisher boundary under `src/publisher/` for the irreversible X side effect. Store Telegram delivery metadata directly on `sp_post_candidates`, reuse `sp_published_posts` and `sp_source_usage`, and keep v1 limited to single posts, quote tweets, and Telegram `photo` attachments only.

**Tech Stack:** TypeScript, Node 22, pnpm, Postgres, Vitest, Telegram Bot API, X URL parsing helpers, existing EC2 `clawd/scripts/tweet.js` runtime.

---

## Chunk 1: Repo Shape And Persistence

### File Map

**Create:**
- `src/db/migrations/0003_candidate_telegram_media.sql`
- `src/telegram/photo-batches.ts`
- `src/publisher/x-command.ts`
- `src/publisher/telegram-media.ts`
- `src/publisher/publish-candidate.ts`
- `tests/unit/telegram/photo-batches.test.ts`
- `tests/unit/publisher/x-command.test.ts`

**Modify:**
- `src/db/repositories/candidates-repository.ts`
- `src/orchestrator/state-machine.ts`
- `src/orchestrator/tick.ts`
- `src/commands/tick.ts`
- `src/telegram/client.ts`
- `src/telegram/poll-updates.ts`
- `tests/integration/db/migrate.test.ts`
- `tests/integration/db/repositories.test.ts`
- `tests/integration/orchestrator/tick.test.ts`
- `tests/unit/cli.test.ts`

**External runtime patch, not in repo:**
- `/Users/dylanvu/Projects/bicep-publisher-contract/scripts/tweet.js`
- `/home/ubuntu/clawd/scripts/tweet.js`

### Task 1: Add Candidate Telegram/Media Columns And Repository Support

**Files:**
- Create: `src/db/migrations/0003_candidate_telegram_media.sql`
- Modify: `src/db/repositories/candidates-repository.ts`
- Test: `tests/integration/db/migrate.test.ts`
- Test: `tests/integration/db/repositories.test.ts`

- [ ] **Step 1: Write the failing migration assertions**

Add a new assertion block to `tests/integration/db/migrate.test.ts` that queries `information_schema.columns` for `sp_post_candidates` and expects:

```ts
expect(candidateColumns).toEqual(
  expect.arrayContaining([
    { column_name: 'telegram_message_id', data_type: 'bigint' },
    { column_name: 'media_batch_json', data_type: 'jsonb' },
  ]),
);
```

- [ ] **Step 2: Run the migration test and confirm the new assertion fails**

Run: `pnpm vitest run tests/integration/db/migrate.test.ts`

Expected: FAIL because `telegram_message_id` and `media_batch_json` do not exist yet.

- [ ] **Step 3: Add the migration**

Create `src/db/migrations/0003_candidate_telegram_media.sql`:

```sql
alter table sp_post_candidates
  add column telegram_message_id bigint;

alter table sp_post_candidates
  add column media_batch_json jsonb;

create unique index sp_post_candidates_telegram_message_id_unique
  on sp_post_candidates (telegram_message_id)
  where telegram_message_id is not null;
```

- [ ] **Step 4: Re-run the migration test**

Run: `pnpm vitest run tests/integration/db/migrate.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing repository round-trip test**

Extend `tests/integration/db/repositories.test.ts` so candidate repository coverage now asserts:

```ts
const updated = await candidatesRepository.updateCandidate(created.id, {
  telegramMessageId: '9001',
  mediaBatchJson: {
    kind: 'telegram_photo_batch',
    replyMessageId: 9001,
    mediaGroupId: null,
    capturedAt: '2026-04-14T21:30:00.000Z',
    photos: [{ fileId: 'file-1', fileUniqueId: 'uniq-1', width: 1280, height: 720 }],
  },
});

expect(updated.telegramMessageId).toBe('9001');
expect(updated.mediaBatchJson).toEqual(expect.objectContaining({ kind: 'telegram_photo_batch' }));
```

Also add one repository assertion for lookup/update by Telegram message id:

```ts
const replaced = await candidatesRepository.replaceMediaBatchByTelegramMessageId({
  telegramMessageId: '9001',
  allowedStatuses: ['pending_approval', 'reminded', 'held'],
  mediaBatchJson: nextBatch,
});

expect(replaced?.mediaBatchJson).toEqual(nextBatch);
```

- [ ] **Step 6: Run the repository test and confirm it fails**

Run: `pnpm vitest run tests/integration/db/repositories.test.ts`

Expected: FAIL on missing fields/methods.

- [ ] **Step 7: Implement the repository fields and helper methods**

Update `src/db/repositories/candidates-repository.ts`:

```ts
export type CandidateRecord = {
  // existing fields...
  telegramMessageId: string | null;
  mediaBatchJson: unknown;
};
```

Add field mapping in `CandidateRow`, `mapCandidateRow`, `createCandidate`, `updateCandidate`, and `transitionStatus`.

Add one targeted helper:

```ts
replaceMediaBatchByTelegramMessageId(input: {
  telegramMessageId: string;
  allowedStatuses: string[];
  mediaBatchJson: unknown;
}): Promise<CandidateRecord | null>
```

This helper should update only rows matching both:
- `telegram_message_id = $1`
- `status = any($2::text[])`

- [ ] **Step 8: Re-run the repository test**

Run: `pnpm vitest run tests/integration/db/repositories.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the persistence slice**

Run:

```bash
git add src/db/migrations/0003_candidate_telegram_media.sql \
  src/db/repositories/candidates-repository.ts \
  tests/integration/db/migrate.test.ts \
  tests/integration/db/repositories.test.ts
git commit -m "feat: persist telegram media on candidates"
```

## Chunk 2: Telegram Reply Capture And Publisher Boundary

### Task 2: Extend Telegram Types And Capture Photo Replies

**Files:**
- Create: `src/telegram/photo-batches.ts`
- Create: `tests/unit/telegram/photo-batches.test.ts`
- Modify: `src/telegram/client.ts`
- Modify: `src/telegram/poll-updates.ts`
- Modify: `src/orchestrator/tick.ts`
- Test: `tests/integration/orchestrator/tick.test.ts`

- [ ] **Step 1: Write the failing photo-batch unit tests**

Create `tests/unit/telegram/photo-batches.test.ts` covering:
- single-photo reply to a candidate package message
- multi-photo album grouped by `media_group_id`
- newest batch replacing the older one
- non-photo replies returning no batch

Use a helper shape like:

```ts
expect(parsed).toEqual({
  replyMessageId: 8000,
  mediaGroupId: 'album-1',
  photos: [
    { fileId: 'photo-large', fileUniqueId: 'unique-1', width: 1280, height: 720 },
  ],
});
```

- [ ] **Step 2: Run the new unit file and confirm it fails**

Run: `pnpm vitest run tests/unit/telegram/photo-batches.test.ts`

Expected: FAIL because the Telegram message schema only supports text today.

- [ ] **Step 3: Extend the Telegram client shapes**

Update `src/telegram/client.ts` so `TelegramMessage`/`TelegramUpdate` can carry:

```ts
type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number | undefined;
};
```

Add support for:
- `message.photo`
- `message.caption`
- `message.media_group_id`
- `reply_to_message.message_id`
- `getFile(fileId)`
- `sendMessage({ text, disableWebPagePreview })`

Keep `sendCandidatePackage(...)` as a convenience wrapper around `sendMessage(...)`.

- [ ] **Step 4: Add the photo-batch helper and use it from the poller**

Create `src/telegram/photo-batches.ts` with one exported helper such as:

```ts
export function collectTelegramPhotoReplyBatches(
  updates: readonly TelegramUpdate[],
): TelegramPhotoBatch[]
```

The helper should:
- ignore non-photo messages
- require `reply_to_message.message_id`
- group albums by `(replyMessageId, media_group_id)`
- keep the largest photo variant from each message
- return batches in ascending update order so the poller can let the newest one win

Modify `src/telegram/poll-updates.ts` so `pollUpdates()` still records text actions, but also:
- groups reply photos by `reply_to_message.message_id`
- groups albums by `media_group_id` within the current poll batch
- writes the latest batch to `sp_post_candidates.media_batch_json` using `replaceMediaBatchByTelegramMessageId(...)`
- ignores photo replies for candidates not in `pending_approval`, `reminded`, or `held`

Persist exactly this shape:

```ts
{
  kind: 'telegram_photo_batch',
  replyMessageId: 8123,
  mediaGroupId: '987654321',
  capturedAt: now.toISOString(),
  photos: [
    { fileId: 'abc', fileUniqueId: 'def', width: 1280, height: 720 },
  ],
}
```

- [ ] **Step 5: Persist the Telegram message id when candidate messages are sent**

Modify `src/orchestrator/tick.ts` in both send paths:
- after `runSharedDraftPipeline()` sends the initial candidate package
- after `sendReminder()` sends the reminder package

Immediately update the candidate row:

```ts
await candidatesRepository.updateCandidate(candidateId, {
  telegramMessageId: String(sentMessage.message_id),
});
```

Treat the latest candidate-package message as the active reply target.

- [ ] **Step 6: Write the failing integration test for media capture**

Extend `tests/integration/orchestrator/tick.test.ts` with one scenario:
1. create a candidate that reaches `pending_approval`
2. assert the candidate row stores `telegram_message_id`
3. enqueue a Telegram `photo` reply to that message
4. run `runTick(...)`
5. assert `media_batch_json` was replaced with the latest reply batch

Add one negative assertion:

```ts
expect(lateCandidate.mediaBatchJson).toBeNull();
```

for a reply to a candidate already in `post_requested`.

- [ ] **Step 7: Run the targeted tests**

Run:

```bash
pnpm vitest run tests/unit/telegram/photo-batches.test.ts
pnpm vitest run tests/integration/orchestrator/tick.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the Telegram media slice**

Run:

```bash
git add src/telegram/photo-batches.ts \
  src/telegram/client.ts \
  src/telegram/poll-updates.ts \
  src/orchestrator/tick.ts \
  tests/unit/telegram/photo-batches.test.ts \
  tests/integration/orchestrator/tick.test.ts
git commit -m "feat: capture telegram photo replies for candidates"
```

### Task 3: Add The Dedicated Publisher Module

**Files:**
- Create: `src/publisher/x-command.ts`
- Create: `src/publisher/telegram-media.ts`
- Create: `src/publisher/publish-candidate.ts`
- Create: `tests/unit/publisher/x-command.test.ts`
- Modify: `src/telegram/client.ts`
- Modify: `src/orchestrator/state-machine.ts`
- Test: `tests/integration/orchestrator/tick.test.ts`

- [ ] **Step 1: Write the failing X command wrapper tests**

Create `tests/unit/publisher/x-command.test.ts` covering:
- original post, no media
- quote tweet using `--quote <tweet_id>`
- multiple `--media` flags in order
- JSON failure payload from the script

Expected command shape:

```ts
[
  clawdTweetScript,
  '--profile', postProfile,
  '--json',
  '--quote', '2044068240524251460',
  '--media', '/tmp/1.jpg',
  '--media', '/tmp/2.jpg',
  'draft text',
]
```

- [ ] **Step 2: Run the wrapper tests and confirm they fail**

Run: `pnpm vitest run tests/unit/publisher/x-command.test.ts`

Expected: FAIL because `src/publisher/x-command.ts` does not exist.

- [ ] **Step 3: Implement the X command wrapper**

Create `src/publisher/x-command.ts` with one focused function:

```ts
export async function publishToXViaScript(input: {
  clawdTweetScript: string;
  postProfile: string;
  text: string;
  quoteTargetUrl?: string | null | undefined;
  mediaPaths?: readonly string[] | undefined;
}): Promise<{ tweetId: string; url: string; raw: unknown }>
```

Implementation notes:
- use `parseXPostUrl(...)` from `src/enrichment/x/url.ts` for quote targets
- use `execFile`
- require exactly one JSON line on stdout
- throw on `ok: false`
- pass one `--media` pair per temp file path

- [ ] **Step 4: Implement Telegram media download support**

Create `src/publisher/telegram-media.ts` with:

```ts
export async function materializeTelegramPhotoBatch(input: {
  telegramClient: TelegramClient;
  mediaBatchJson: unknown;
}): Promise<{ mediaPaths: string[]; cleanup: () => Promise<void> }>
```

Rules:
- validate `kind === 'telegram_photo_batch'`
- require `1 <= photos.length <= 4`
- call `getFile(fileId)` for each photo
- download each file to a temp directory
- clean up temp files in `finally`

- [ ] **Step 5: Implement publish orchestration**

Create `src/publisher/publish-candidate.ts` with:

```ts
export async function publishCandidate(input: {
  db: Queryable;
  telegramClient: TelegramClient;
  candidateId: string;
  postProfile: string;
  clawdTweetScript: string;
  now?: () => Date | undefined;
}): Promise<{ outcome: 'published' | 'ignored'; xPostId: string | null }>
```

Implementation order:
1. load candidate
2. no-op unless status is `post_requested`
3. require `finalPostText`
4. materialize photo batch if present
5. call `publishToXViaScript(...)`
6. atomically persist publish bookkeeping with one SQL statement

Use one SQL statement so `sp_published_posts`, `sp_source_usage`, and the `published` status advance together:

```sql
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
  insert into sp_published_posts (...)
  select ... from updated_candidate
  returning id, x_post_id
)
insert into sp_source_usage (event_id, artifact_id, published_post_id)
select candidate_sources.event_id, candidate_sources.artifact_id, inserted_post.id
from sp_candidate_sources candidate_sources
cross join inserted_post
where candidate_sources.candidate_id = $1;
```

On any failure after the candidate is already `post_requested`, transition:

```ts
await candidatesRepository.transitionStatus({
  id: candidateId,
  fromStatuses: ['post_requested'],
  toStatus: 'delivery_failed',
  errorDetails: message,
});
await telegramClient.sendMessage({ text: `X publish failed for candidate #${candidateId}: ${message}` });
```

- [ ] **Step 6: Make `published` first-class in orchestration types**

Update `src/orchestrator/state-machine.ts`:

```ts
export type CandidateStatus =
  | 'selector_skipped'
  | 'drafting'
  | 'drafter_skipped'
  | 'pending_approval'
  | 'reminded'
  | 'held'
  | 'skipped'
  | 'post_requested'
  | 'published'
  | 'delivery_failed';
```

Do not add `published` to automation lists.

- [ ] **Step 7: Add failing integration assertions for publish success and failure**

Extend `tests/integration/orchestrator/tick.test.ts` with two new cases:

Success:
- reply `post now` to a pending candidate
- inject a fake X publisher success
- run `runTick(...)`
- assert candidate status is `published`
- assert one row exists in `sp_published_posts`
- assert matching `sp_source_usage` rows were written
- assert no Telegram failure message was sent

Failure:
- create a `post_requested` candidate with `media_batch_json.photos.length === 5`
- run `runTick(...)`
- assert candidate status is `delivery_failed`
- assert `error_details` mentions the 4-photo limit
- assert one Telegram failure message was sent

- [ ] **Step 8: Run the publisher-focused tests**

Run:

```bash
pnpm vitest run tests/unit/publisher/x-command.test.ts
pnpm vitest run tests/integration/orchestrator/tick.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the publisher boundary**

Run:

```bash
git add src/publisher/x-command.ts \
  src/publisher/telegram-media.ts \
  src/publisher/publish-candidate.ts \
  src/telegram/client.ts \
  src/orchestrator/state-machine.ts \
  tests/unit/publisher/x-command.test.ts \
  tests/integration/orchestrator/tick.test.ts
git commit -m "feat: add immediate x publisher"
```

## Chunk 3: Immediate Tick Wiring And Real Runtime Verification

### Task 4: Invoke The Publisher Immediately From `tick`

**Files:**
- Modify: `src/orchestrator/tick.ts`
- Modify: `src/commands/tick.ts`
- Test: `tests/integration/orchestrator/tick.test.ts`
- Test: `tests/unit/cli.test.ts`

- [ ] **Step 1: Write the failing tick assertions for immediate publish**

Add integration coverage to `tests/integration/orchestrator/tick.test.ts` proving both paths publish immediately:
- manual `post now`
- scheduled deadline auto-post

The expected post-state is:

```ts
expect(candidate.status).toBe('published');
expect(result.postRequestedCandidateIds).toEqual([candidate.id]);
```

The `postRequestedCandidateIds` list should still reflect that a publish was requested during the tick, even though the terminal persisted state is now `published`.

- [ ] **Step 2: Run the tick tests and confirm they fail**

Run: `pnpm vitest run tests/integration/orchestrator/tick.test.ts`

Expected: FAIL because `runTick(...)` currently stops at `post_requested`.

- [ ] **Step 3: Wire the publisher into the action loop**

In `src/orchestrator/tick.ts`, after `applyCandidateAction(...)`:

```ts
if (actionResult.candidate?.status === 'post_requested') {
  await publishCandidate({
    db: input.db,
    telegramClient: input.telegramClient,
    candidateId: actionResult.candidate.id,
    postProfile: input.postProfile,
    clawdTweetScript: input.clawdTweetScript,
    now,
  });
  postRequestedCandidateIds.push(actionResult.candidate.id);
}
```

- [ ] **Step 4: Wire the publisher into the timer loop**

In the `request_post` branch, publish immediately after a successful transition:

```ts
if (transitioned) {
  await publishCandidate({
    db: input.db,
    telegramClient: input.telegramClient,
    candidateId: transitioned.id,
    postProfile: input.postProfile,
    clawdTweetScript: input.clawdTweetScript,
    now,
  });
  postRequestedCandidateIds.push(transitioned.id);
}
```

- [ ] **Step 5: Thread publisher config from env to `runTick(...)`**

Update `src/orchestrator/tick.ts` input types and `src/commands/tick.ts` wiring so `runTick(...)` receives:

```ts
postProfile: env.postProfile,
clawdTweetScript: env.clawdTweetScript,
```

No new env vars are required.

- [ ] **Step 6: Re-run the orchestration tests**

Run:

```bash
pnpm vitest run tests/integration/orchestrator/tick.test.ts
pnpm vitest run tests/unit/cli.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run the full local gate before touching EC2**

Run:

```bash
pnpm test
pnpm tsc --noEmit
git diff --check
```

Expected:
- `pnpm test`: PASS
- `pnpm tsc --noEmit`: PASS
- `git diff --check`: no output

- [ ] **Step 8: Commit the immediate-publish wiring**

Run:

```bash
git add src/orchestrator/tick.ts src/commands/tick.ts tests/integration/orchestrator/tick.test.ts tests/unit/cli.test.ts
git commit -m "feat: publish post requests immediately"
```

### Task 5: Patch `tweet.js` For Multiple Media Files

**Files:**
- Modify: `/Users/dylanvu/Projects/bicep-publisher-contract/scripts/tweet.js`
- Later port to: `/home/ubuntu/clawd/scripts/tweet.js`

- [ ] **Step 1: Reproduce the current single-media limitation in the scratch copy**

Use a local stub harness that inspects argv and asserts both media paths arrive. The red condition is that only the last `--media` survives today.

Run:

```bash
node --check /Users/dylanvu/Projects/bicep-publisher-contract/scripts/tweet.js
```

Expected: syntax OK before patching.

- [ ] **Step 2: Patch the scratch copy**

Change the runtime from a single `mediaPath` variable to ordered `mediaPaths: string[]`.

Required edits:
- parse repeated `--media <path>` pairs
- upload each media file in order
- send `options.media = { media_ids: uploadedMediaIds }`
- keep JSON mode single-line output unchanged

Core change:

```js
let mediaPaths = [];
// ...
} else if (args[0] === '--media' && args[1]) {
  mediaPaths.push(args[1]);
  args = args.slice(2);
}
```

- [ ] **Step 3: Re-run the scratch runtime contract checks**

Run:

```bash
node --check /Users/dylanvu/Projects/bicep-publisher-contract/scripts/tweet.js
```

Expected: PASS.

Then re-run the local stub harness that validates:
- JSON success remains one line
- `--quote` still works
- both `--media` flags survive

- [ ] **Step 4: Port only the minimal diff to EC2**

Do not overwrite the whole live file. Re-copy first, then patch only the media hunks on `/home/ubuntu/clawd/scripts/tweet.js`.

- [ ] **Step 5: Verify the live runtime contract on EC2**

Run on EC2:

```bash
node --check /home/ubuntu/clawd/scripts/tweet.js
```

Expected: PASS.

Re-run the same non-posting stub harness against the EC2 path and confirm:
- JSON output remains parseable
- `--quote` still works
- repeated `--media` flags survive

### Task 6: Real EC2 Verification

**Files:**
- Modify in repo: implementation commits from Tasks 1-4
- Verify on EC2 repo: `/home/ubuntu/social-posting`
- Verify runtime: `/home/ubuntu/clawd/scripts/tweet.js`

- [ ] **Step 1: Pull the implementation onto EC2 without clobbering local runtime drift**

On EC2:

```bash
cd /home/ubuntu/social-posting
git status --short
git pull --ff-only
```

Expected: clean fast-forward pull, or stop and manually resolve if the tree is dirty.

- [ ] **Step 2: Run DB migrations on EC2**

On EC2:

```bash
cd /home/ubuntu/social-posting
set -a && . ./.env && set +a
export PATH="$HOME/.local/bin:$PATH"
pnpm migrate
```

Expected: JSON array including `0003_candidate_telegram_media.sql` on first run, then `[]` on a second run.

- [ ] **Step 3: Run the local repo gate on EC2**

On EC2:

```bash
cd /home/ubuntu/social-posting
set -a && . ./.env && set +a
export PATH="$HOME/.local/bin:$PATH"
pnpm test
pnpm tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Exercise the live draft path**

On EC2:

```bash
cd /home/ubuntu/social-posting
set -a && . ./.env && set +a
export PATH="$HOME/.local/bin:$PATH"
pnpm draft-now
```

Expected: JSON like `{"candidateId":"<id>"}` and a Telegram candidate package message.

- [ ] **Step 5: Verify the candidate row captured the Telegram message id**

On EC2:

```bash
psql "$DATABASE_URL" -c "
  select id, status, telegram_message_id, quote_target_url, media_request
  from sp_post_candidates
  order by id desc
  limit 1;
"
```

Expected:
- `status = pending_approval`
- `telegram_message_id` is non-null

- [ ] **Step 6: Reply in Telegram with one photo, then trigger publish**

Human action:
- reply to the candidate Telegram message with one `photo`
- reply `post now`

Then on EC2 run:

```bash
cd /home/ubuntu/social-posting
set -a && . ./.env && set +a
export PATH="$HOME/.local/bin:$PATH"
pnpm tick
```

Expected:
- JSON output with `postRequestedCandidateIds` containing the candidate id
- no Telegram success message
- no stderr failure

- [ ] **Step 7: Verify publish persistence in Postgres**

On EC2:

```bash
psql "$DATABASE_URL" -c "
  select id, status, error_details, media_batch_json
  from sp_post_candidates
  order by id desc
  limit 1;
"

psql "$DATABASE_URL" -c "
  select candidate_id, x_post_id, post_type, final_text, quote_target_url, media_attached
  from sp_published_posts
  order by id desc
  limit 1;
"

psql "$DATABASE_URL" -c "
  select event_id, artifact_id, published_post_id
  from sp_source_usage
  where published_post_id = (
    select id from sp_published_posts order by id desc limit 1
  )
  order by event_id, artifact_id nulls first;
"
```

Expected:
- candidate `status = published`
- `error_details` is null
- `media_batch_json` contains the photo batch if one was supplied
- latest `sp_published_posts` row matches the candidate and has `media_attached = true`
- `sp_source_usage` rows exist for the candidate sources

- [ ] **Step 8: Verify the actual X post**

Use the `url` from `sp_published_posts.publisher_response` or reconstruct it from `x_post_id`. Confirm:
- the post exists on X
- quote tweet target is correct when `quote_target_url` was set
- attached photo appears when a photo was supplied

- [ ] **Step 9: Record the verification evidence in the handoff**

Capture:
- candidate id
- final status
- `x_post_id`
- whether media attached was true/false
- exact EC2 commands run
- any failure Telegram messages observed

## Acceptance Checklist

- [ ] Candidate rows store `telegram_message_id` and `media_batch_json`
- [ ] Candidate package sends persist the latest Telegram message id
- [ ] Photo replies to candidate Telegram messages replace the stored media batch
- [ ] Replies after `post_requested` are ignored
- [ ] `tick` publishes immediately after `post now` and scheduled deadlines
- [ ] Publish success inserts `sp_published_posts`
- [ ] Publish success inserts `sp_source_usage`
- [ ] Publish success transitions `post_requested -> published`
- [ ] Publish failure transitions `post_requested -> delivery_failed`
- [ ] Publish failure notifies Telegram once
- [ ] Publish success stays silent in Telegram
- [ ] `tweet.js` supports `--json`, `--quote`, and repeated `--media`
- [ ] EC2 real verification proves one live candidate drafts, accepts a photo reply, and publishes successfully
