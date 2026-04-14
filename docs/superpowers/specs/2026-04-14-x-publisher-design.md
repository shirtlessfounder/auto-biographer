# X Publisher V1 Design

## Goal

Add the missing publisher stage to the social-posting system so a candidate that reaches `post_requested` is published to X immediately, using the existing Telegram approval flow and the existing `clawd/scripts/tweet.js` runtime on EC2.

This design is intentionally narrow:

- X only
- single posts and quote tweets only
- no reply-guy
- no Discord
- no sweeper or retry worker
- no video or document media support

## Current State

The system already does the following in production:

- normalizes rolling context from Slack, Innies, GitHub, and X quote targets
- runs Hermes selector + drafter passes
- persists `sp_post_candidates`
- sends candidate packages to Telegram
- accepts Telegram text commands like `hold`, `skip`, `post now`, and `edit: ...`
- transitions approved candidates to `post_requested`

The missing piece is the irreversible publish boundary:

- no code currently consumes `post_requested`
- no media reply handling exists
- no X post is recorded into `sp_published_posts`
- no source usage is recorded after publish

## Product Decisions

The following decisions are fixed for v1:

- publishing happens immediately when the system decides to post
- there is no cron-based publisher and no fallback sweeper
- photo media must be supplied by replying to the candidate Telegram message
- reply photos are associated automatically with no extra command
- only Telegram `photo` attachments are supported
- the latest photo-reply batch replaces any earlier photo batch
- Telegram captions on photo replies are ignored
- if no photo batch exists at publish time, the candidate publishes text-only
- if more than 4 photos are supplied in the latest batch, publish fails and notifies Dylan
- quote tweets may also attach photos if a photo batch exists
- failures notify in Telegram
- successful publishes stay silent in Telegram
- if an original-post candidate reaches deadline without photos, it publishes text-only

## Architecture

### Boundary

V1 uses a dedicated publisher module with immediate invocation from the existing orchestration flow.

- `tick` remains the orchestrator entrypoint
- `tick` still polls Telegram, applies state transitions, drafts candidates, sends reminders, and transitions candidates to `post_requested`
- once a candidate becomes `post_requested`, `tick` immediately calls a dedicated `publishCandidate(...)` service

This keeps real-time behavior while preserving a clean separation:

- orchestration decides *when* a post should happen
- publisher owns *how* the X post happens

### Why not inline publish logic in `tick`?

Inlining would save a few files but would mix:

- Telegram polling
- scheduling/reminders
- Hermes drafting
- irreversible X side effects

That would make the hottest and riskiest path harder to test and reason about. A dedicated publisher module is the smallest design that stays sane.

## Data Model

V1 keeps the schema small and avoids adding a new media table.

### `sp_post_candidates`

Add two nullable columns:

- `telegram_message_id bigint`
- `media_batch_json jsonb`

`telegram_message_id` stores the Telegram candidate-package message id returned by `sendMessage`.

`media_batch_json` stores the latest valid photo batch for that candidate. It is the single source of truth for what media should be used at publish time.

Suggested shape:

```json
{
  "kind": "telegram_photo_batch",
  "replyMessageId": 12345,
  "mediaGroupId": "67890",
  "capturedAt": "2026-04-14T21:30:00.000Z",
  "photos": [
    {
      "fileId": "abc",
      "fileUniqueId": "def",
      "width": 1280,
      "height": 720
    }
  ]
}
```

Only the latest batch matters. A newer photo reply replaces the earlier batch entirely.

### Existing tables reused

- `sp_published_posts` records the successful X publish
- `sp_candidate_sources` already tells us which events/artifacts supported the candidate
- `sp_source_usage` is written after successful publish so those same sources are excluded from future context

No new table is needed in v1.

## Telegram Behavior

### Candidate package send

When a candidate package is sent to Telegram:

- the existing message format remains unchanged
- the returned Telegram `message_id` is persisted onto the candidate row

### Polling updates

Telegram polling continues to run through the existing poller, but reply handling expands:

- text replies still map to control commands as they do now
- photo replies to a candidate message update that candidate’s `media_batch_json`

Photo association should key off the Telegram reply target:

- match `reply_to_message.message_id` to the candidate row’s stored `telegram_message_id`
- do not rely on parsing the replied message text for media association

Photo replies are valid only when:

- they are replies to a candidate-package message
- the candidate is still in a pre-publish state (`pending_approval`, `reminded`, or `held`)

After a candidate is already `post_requested`, later photo replies are ignored. Publish is immediate at that point.

### Photo semantics

- support Telegram `photo` only
- ignore captions entirely
- use the newest reply batch only
- store every photo in that reply batch
- fail publish if the stored batch contains more than 4 photos

For Telegram albums:

- a multi-photo reply is represented by multiple Telegram messages sharing the same `media_group_id`
- v1 should treat one `media_group_id` as one photo batch
- a single-photo reply is treated as a batch of one
- the latest batch means the latest single reply message or latest `media_group_id`

## Publish Flow

### Trigger

`publishCandidate(...)` is called immediately after a candidate transitions to `post_requested`.

This happens in two cases:

- manual `post now`
- scheduled auto-post at deadline

### Candidate load and validation

The publisher:

1. loads the candidate by id
2. verifies status is still `post_requested`
3. verifies `final_post_text` exists
4. reads `quote_target_url` and `media_batch_json`

### Media preparation

If `media_batch_json` is absent:

- publish text-only

If `media_batch_json` is present:

1. validate batch size is between 1 and 4
2. resolve the highest-resolution photo variant per image from Telegram
3. fetch Telegram file metadata via `getFile`
4. download each photo to a temp file on EC2
5. pass all temp file paths to the X publisher wrapper

If any media preparation step fails:

- mark candidate `delivery_failed`
- send one Telegram failure message
- do not retry automatically

### X publish

The publisher calls the patched `clawd/scripts/tweet.js` in JSON mode.

Modes:

- original post: text + optional media list
- quote tweet: `--quote <tweet_id>` + text + optional media list

The publisher must depend on machine-readable JSON success/failure output from `tweet.js`.

### Success path

On successful X publish:

1. insert a row into `sp_published_posts`
2. insert `sp_source_usage` rows for all `sp_candidate_sources` attached to the candidate
3. transition candidate status from `post_requested` to `published`
4. stay silent in Telegram

### Failure path

On publish failure:

1. transition candidate status from `post_requested` to `delivery_failed`
2. store the failure message in `error_details`
3. send one Telegram failure message with the reason
4. do not retry automatically

## `tweet.js` Contract Changes

The live EC2 `clawd/scripts/tweet.js` runtime must support:

- `--json`
- `--quote <tweet_id>`
- multiple `--media <path>` flags
- parseable single-line JSON success/failure output

The publisher will treat that script as the X runtime boundary for v1.

## Status Model

V1 reuses the existing candidate lifecycle and adds one real terminal success state in practice:

- `pending_approval`
- `reminded`
- `held`
- `post_requested`
- `published`
- `delivery_failed`

`published` is already tolerated by tests/repositories even though the current state-machine union does not list it yet. The publisher/state-machine boundary should make it a first-class handled status.

The publisher implementation must also add explicit transition support for:

- `post_requested -> published`
- `post_requested -> delivery_failed`

## Testing Strategy

### Unit tests

- Telegram photo-reply parsing and candidate id extraction
- media batch replacement behavior
- publisher command construction for original posts and quote tweets
- publisher failure on more than 4 photos
- Hermes/X output parsing remains covered

### Integration tests

- candidate package send persists Telegram message id
- photo reply updates candidate media batch
- `post now` or auto-post transitions to `post_requested` and immediately invokes publisher
- successful publish inserts `sp_published_posts`, marks source usage, and marks candidate `published`
- failed publish marks candidate `delivery_failed`

### Runtime contract verification

- verify patched `tweet.js` accepts multiple `--media`
- verify quote tweet + JSON mode still works
- verify EC2 `tick` / `draft-now` flow still works with the publisher added

## Out of Scope

The following are explicitly deferred:

- video support
- Telegram document support
- post-publish success notifications
- retry workers
- publish cron or sweeper
- stale `post_requested` recovery
- X threads as a publish format
- editing captions into draft text
- media galleries larger than 4 images

## Implementation Notes

This feature should preserve the current project philosophy:

- immediate event-driven behavior
- minimal moving parts
- one clear boundary around irreversible X side effects
- no new scheduler unless reality proves we need one later
