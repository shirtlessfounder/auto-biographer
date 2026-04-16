# Hermes + auto-biographer Single-Bot Telegram Integration Plan

> For Hermes: use subagent-driven-development if executing this later. Do not let auto-biographer poll Telegram directly. Hermes is the only Telegram ingress owner.

Goal: keep one Telegram bot, let Hermes own all Telegram ingress/egress, and make auto-biographer a backend workflow engine for draft control, media attachment, and publish actions.

Architecture: Hermes becomes the transport/router layer for Telegram. auto-biographer stops using getUpdates and stops owning the bot token lifecycle. Draft control messages sent by Hermes are recorded in auto-biographer with message-level mappings so any reply or photo reply to any active control message can be resolved back to the correct candidate.

Tech stack: Hermes gateway (python-telegram-bot), auto-biographer (TypeScript, pg, zod), Postgres, existing X publisher flow.

---

## Root cause recap

Current bug is a combination of two issues:

1. Double Telegram ownership
   - Hermes gateway polls Telegram using the same bot token as auto-biographer.
   - auto-biographer also polls Telegram via `getUpdates` in `src/telegram/poll-updates.ts`.
   - One bot token can only have one reliable update consumer.
   - Result: replies/photos are racey, stolen, or dropped depending on which process receives the update.

2. Candidate message identity is modeled wrong
   - auto-biographer stores one `telegram_message_id` on `sp_post_candidates`.
   - reminder sends overwrite the original draft message id.
   - photo replies are associated by `reply_to_message.message_id == candidate.telegram_message_id`.
   - Result: image replies to the original draft can stop attaching once a reminder is sent.

Non-goals for this refactor:
- no second Telegram bot
- no new public control surface outside Hermes
- no partial “both systems poll Telegram” compromise
- no redesign of X publishing itself

---

## Desired end state

1. Hermes is the only codebase that receives Telegram updates.
2. Hermes sends the draft-control messages to Telegram.
3. auto-biographer persists candidates, actions, message mappings, media batches, and publish state.
4. Hermes intercepts replies/photos that target auto-biographer control messages and routes them into auto-biographer instead of the normal chat session.
5. Any reply to any active draft-control message for a candidate should resolve correctly, including reminders.
6. Main Hermes chat remains the same bot and same DM; draft controls are just a routed subflow.

---

## High-level design

### New ownership split

Hermes owns:
- Telegram polling / webhook ingress
- Telegram message sending
- message routing / interception
- session suppression for matched control replies

auto-biographer owns:
- candidate lifecycle
- command parsing semantics for control actions
- persistence of control-message mappings
- media association to candidates
- publish pipeline

### Transport boundary

Replace direct Telegram client usage inside auto-biographer orchestration with a narrow notifier + ingest API.

New conceptual boundaries:
- `DraftControlNotifier` — send draft package / reminder / failure via Hermes-provided adapter
- `DraftControlIngress` — record text action or photo reply against a candidate/control message

---

## Data model changes

### Task 1: Add control-message mapping table

Objective: stop relying on a single `telegram_message_id` on the candidate row.

Files:
- Create: `src/db/migrations/0004_candidate_control_messages.sql`
- Modify: `src/db/repositories/candidates-repository.ts`
- Create: `src/db/repositories/candidate-control-messages-repository.ts`
- Test: `tests/integration/db/repositories.test.ts`

Schema:
- table: `sp_candidate_control_messages`
- columns:
  - `id bigserial primary key`
  - `candidate_id bigint not null references sp_post_candidates(id) on delete cascade`
  - `telegram_message_id bigint not null unique`
  - `message_kind text not null check (message_kind in ('draft','reminder','status','publish_failure'))`
  - `is_active boolean not null default true`
  - `created_at timestamptz not null default now()`
- indexes:
  - `(candidate_id, is_active)`
  - unique `(telegram_message_id)`

Keep `sp_post_candidates.telegram_message_id` temporarily during migration for compatibility, then remove in a later cleanup task after all call sites are updated.

Step 1: write failing repository tests for:
- storing multiple control messages for one candidate
- resolving candidate by replied-to telegram message id
- deactivating prior reminder/draft mappings if desired

Step 2: add the migration.

Step 3: add repository methods:
- `recordControlMessage(candidateId, telegramMessageId, messageKind)`
- `findCandidateByTelegramMessageId(telegramMessageId, allowedStatuses?)`
- `listControlMessages(candidateId)`
- optional: `deactivateControlMessages(candidateId, kinds?)`

Step 4: run:
- `pnpm test -- repositories`
- `pnpm typecheck`

Step 5: commit:
- `git commit -m "feat: add candidate control message mappings"`

### Task 2: Switch media association to control-message mappings

Objective: make photo replies attach via any active control message id, not a single candidate field.

Files:
- Modify: `src/telegram/poll-updates.ts`
- Modify: `src/db/repositories/candidates-repository.ts`
- Modify: `src/db/repositories/candidate-control-messages-repository.ts`
- Test: `tests/integration/orchestrator/tick.test.ts`
- Test: `tests/unit/telegram/photo-batches.test.ts`

Change:
- replace `replaceMediaBatchByTelegramMessageId(...)` lookup on candidate row with repository resolution through `sp_candidate_control_messages`.
- allow replies to either original draft or reminder message.

Step 1: add failing integration test:
- send candidate package
- send reminder
- reply with photo to original draft message
- expect candidate media batch to update successfully

Step 2: update poller to resolve `replyMessageId` through the new mapping repository.

Step 3: verify latest batch still wins.

Step 4: run:
- `pnpm vitest run tests/unit/telegram/photo-batches.test.ts`
- `pnpm vitest run tests/integration/orchestrator/tick.test.ts`

Step 5: commit:
- `git commit -m "fix: attach telegram media via control message mappings"`

---

## auto-biographer app refactor

### Task 3: Introduce transport-agnostic draft-control ports

Objective: remove hard dependency on Telegram client behavior from orchestration logic.

Files:
- Create: `src/control/ports.ts`
- Modify: `src/orchestrator/tick.ts`
- Modify: `src/publisher/publish-candidate.ts`
- Modify: `src/commands/tick.ts`
- Modify: `src/commands/draft-now.ts`
- Test: `tests/integration/orchestrator/tick.test.ts`
- Test: `tests/integration/publisher/publish-candidate.test.ts`

New interfaces:
- `DraftControlNotifier`
  - `sendCandidatePackage(input) -> { messageId: string }`
  - `sendReminder(input) -> { messageId: string }`
  - `sendFailureNotice(input) -> { messageId?: string | null }`
- `DraftControlMediaStore`
  - optional separate interface if cleaner for ingest path

Implementation rule:
- `runTick` and `publishCandidate` should depend on notifier interfaces, not raw Telegram client methods.
- this preserves the same behavior while making Hermes the outer adapter later.

Step 1: add failing tests that inject a fake notifier instead of a fake Telegram client.

Step 2: refactor orchestrator send paths:
- initial draft send
- reminder send
- selector/drafter skip notice
- publish failure notice

Step 3: preserve exact message body format for now.

Step 4: run:
- `pnpm vitest run tests/integration/orchestrator/tick.test.ts`
- `pnpm vitest run tests/integration/publisher/publish-candidate.test.ts`
- `pnpm typecheck`

Step 5: commit:
- `git commit -m "refactor: decouple draft control from telegram client"`

### Task 4: Remove Telegram polling from auto-biographer runtime path

Objective: make auto-biographer stop consuming Telegram updates directly.

Files:
- Modify: `src/orchestrator/tick.ts`
- Modify: `src/commands/tick.ts`
- Modify: `src/telegram/poll-updates.ts`
- Modify: `src/telegram/client.ts`
- Modify: `src/config/env.ts`
- Modify: `README.md`
- Test: `tests/unit/commands/tick.test.ts`
- Test: `tests/integration/orchestrator/tick.test.ts`

Change:
- delete or deprecate `createTelegramUpdatePoller` from the production tick path.
- `runTick` should no longer call `poller.pollUpdates()`.
- draft-control actions/media now enter through an explicit ingest API, not by side-effect polling during tick.

Important: keep helper parsers (`command-parser.ts`, `photo-batches.ts`) if still useful for Hermes-side routing or tests.

Step 1: add failing test proving `runTick` no longer calls `getUpdates`.

Step 2: change `runTick` to only do:
- due slot evaluation
- draft generation
- reminders
- deadline-triggered publish

Step 3: move text/photo ingestion to new service functions:
- `recordDraftControlAction(...)`
- `recordDraftControlPhotoReply(...)`

Step 4: update env loading docs:
- auto-biographer should no longer require `TELEGRAM_CONTROL_BOT_TOKEN` for ingress ownership
- may still use Hermes-delivered notifier bridge config if needed

Step 5: run:
- `pnpm vitest run tests/unit/commands/tick.test.ts`
- `pnpm vitest run tests/integration/orchestrator/tick.test.ts`
- `pnpm typecheck`

Step 6: commit:
- `git commit -m "refactor: remove telegram polling from auto-biographer tick"`

### Task 5: Add explicit ingress services for replies and photo replies

Objective: give Hermes a stable API to call when it intercepts Telegram replies.

Files:
- Create: `src/control/ingest.ts`
- Modify: `src/orchestrator/state-machine.ts`
- Modify: `src/db/repositories/telegram-actions-repository.ts`
- Modify: `src/db/repositories/candidate-control-messages-repository.ts`
- Test: `tests/integration/orchestrator/tick.test.ts`

Functions to add:
- `ingestDraftControlTextReply({ telegramUpdateId, telegramMessageId, actorUserId, replyToTelegramMessageId, text })`
- `ingestDraftControlPhotoReply({ telegramUpdateId, telegramMessageId, actorUserId, replyToTelegramMessageId, mediaGroupId, photos })`

Behavior:
- resolve candidate by `replyToTelegramMessageId`
- for text: parse action using existing parser semantics (`skip`, `hold`, `post now`, `edit: ...`, `another angle`)
- for photo: replace media batch if candidate still in active pre-publish status
- return a routing result enum:
  - `matched_and_applied`
  - `matched_but_ignored`
  - `not_a_control_reply`

Step 1: add failing tests for each routing result.

Step 2: implement the services using repositories + state machine.

Step 3: make the action parser reusable without requiring full Telegram Update shape.

Step 4: run:
- `pnpm vitest run tests/integration/orchestrator/tick.test.ts`
- `pnpm typecheck`

Step 5: commit:
- `git commit -m "feat: add explicit draft control ingest services"`

---

## Hermes refactor

### Task 6: Add a gateway hook/router for auto-biographer draft-control replies

Objective: Hermes should intercept replies to auto-biographer control messages before normal chat handling.

Files:
- Create: `/home/ubuntu/.hermes/hermes-agent/gateway/builtin_hooks/auto_biographer_control.py` or a dedicated integration module under Hermes source
- Modify: `/home/ubuntu/.hermes/hermes-agent/gateway/hooks.py` if needed for registration
- Modify: `/home/ubuntu/.hermes/hermes-agent/gateway/platforms/telegram.py` only if extra metadata is required
- Test: Hermes-side unit/integration tests under `/home/ubuntu/.hermes/hermes-agent/tests/gateway/`

Preferred design:
- do not bake auto-biographer logic directly into `telegram.py`
- add a gateway-level interceptor that sees `MessageEvent` with:
  - `reply_to_message_id`
  - `text`
  - `media_urls`
  - `raw_message`
- if the reply targets a known auto-biographer control message, route it to auto-biographer ingress and mark the event handled
- otherwise continue normal Hermes session handling

Routing logic:
1. check Telegram platform only
2. require `reply_to_message_id`
3. call auto-biographer ingress service / CLI bridge
4. if matched, optionally react/ack and suppress normal agent processing
5. if not matched, let Hermes continue as usual

Step 1: add failing Hermes test: replying `post now` to a mapped control message should not reach the normal session.

Step 2: add a minimal integration bridge from Hermes to auto-biographer. simplest v1 options:
- direct DB access from Hermes using the same DATABASE_URL
- or subprocess call into an auto-biographer CLI command

Recommendation: use direct DB-backed ingress through a tiny TypeScript CLI command first, not raw SQL from Hermes. Keep business logic in auto-biographer.

Step 3: implement interception for:
- text replies
- photo replies
- photo albums (already batched by Hermes Telegram adapter)

Step 4: run Hermes tests:
- `source /home/ubuntu/.hermes/hermes-agent/venv/bin/activate && python -m pytest /home/ubuntu/.hermes/hermes-agent/tests/gateway/ -q`

Step 5: commit in Hermes repo:
- `git commit -m "feat: route auto-biographer draft replies through hermes gateway"`

### Task 7: Add Hermes-side sender for auto-biographer control messages

Objective: Hermes should send the Telegram draft/reminder/failure messages and return message ids back to auto-biographer.

Files:
- Modify Hermes integration bridge module from Task 6
- Create auto-biographer CLI/API entrypoint if needed: `src/commands/control-ingest.ts` and/or `src/commands/control-send.ts`
- Modify `src/cli.ts`
- Test in both repos

Recommendation:
- easiest v1: auto-biographer continues formatting messages, Hermes continues sending them.
- notifier bridge path:
  1. auto-biographer creates candidate + formatted message payload
  2. Hermes adapter sends it to Telegram using the existing gateway bot
  3. Hermes returns `message_id`
  4. auto-biographer records control-message mapping

If synchronous cross-process send is too awkward for the first pass, do this simpler version:
- let auto-biographer enqueue an outbound control-message row in DB
- Hermes background worker/hook sends pending outbound rows and records Telegram message ids

Between the two, DB-backed outbound queue is cleaner for one-bot ownership.

Preferred queue schema:
- `sp_outbound_control_messages`
  - `id`
  - `candidate_id`
  - `message_kind`
  - `payload_json`
  - `status` (`pending`, `sent`, `failed`)
  - `telegram_message_id`
  - `error_details`
  - timestamps

Hermes sender loop can live in startup task / cron / gateway background task.

Step 1: choose queue approach over synchronous subprocess coupling.

Step 2: add failing auto-biographer test proving draft creation enqueues outbound control message instead of calling Telegram directly.

Step 3: add Hermes sender worker test proving pending control messages are sent and mapped.

Step 4: run repo tests for both sides.

Step 5: commit:
- auto-biographer: `git commit -m "feat: enqueue outbound draft control messages"`
- Hermes: `git commit -m "feat: deliver outbound auto-biographer control messages"`

---

## Recommended final architecture decision

### Use a DB-backed inbox/outbox bridge

This is the cleanest version of “one Telegram bot, Hermes owns transport, auto-biographer owns workflow”.

Inbox path:
- Telegram user reply/photo -> Hermes gateway -> auto-biographer ingress service -> DB state update

Outbox path:
- auto-biographer creates pending outbound control message -> Hermes sender picks it up -> sends to Telegram -> records telegram message id + candidate mapping

Why this is best:
- no second poller
- no second bot
- no direct Telegram client in auto-biographer runtime path
- Hermes remains transport owner
- auto-biographer remains business-logic owner
- retries and observability become easier
- reminder/original message identity bug goes away naturally

---

## Implementation order

1. control-message mapping table
2. media association through mappings
3. notifier interface in auto-biographer
4. explicit ingress services in auto-biographer
5. remove Telegram polling from auto-biographer tick
6. add outbound control-message queue
7. add Hermes sender worker for queued outbound messages
8. add Hermes reply/photo interceptor for inbound control replies
9. remove dead Telegram client ingress code from auto-biographer
10. remove legacy `telegram_message_id` column from candidate row once all references are gone

---

## Verification checklist

### auto-biographer
- replying `skip` to original draft message works
- replying `skip` to reminder message works
- replying photo to original draft after reminder still attaches media
- replying photo to reminder attaches media
- `runTick` no longer calls Telegram `getUpdates`
- scheduled reminders still send correctly through Hermes-owned path
- publish failure notices still reach Telegram

Commands:
- `cd /home/ubuntu/auto-biographer && pnpm vitest run tests/integration/orchestrator/tick.test.ts`
- `cd /home/ubuntu/auto-biographer && pnpm vitest run tests/integration/publisher/publish-candidate.test.ts`
- `cd /home/ubuntu/auto-biographer && pnpm test`
- `cd /home/ubuntu/auto-biographer && pnpm typecheck`

### Hermes
- regular DM chat still behaves normally
- replying to a draft-control message is intercepted and not sent into the normal main session
- photo album reply is batched once and routed once
- non-control replies still reach Hermes chat
- only one Telegram poller exists: Hermes gateway

Commands:
- `source /home/ubuntu/.hermes/hermes-agent/venv/bin/activate && python -m pytest /home/ubuntu/.hermes/hermes-agent/tests/gateway/ -q`

### Manual prod smoke test
1. create on-demand draft
2. verify Hermes sends draft-control message
3. reply `hold`
4. verify candidate transitions to `held`
5. send photo reply to original draft
6. send reminder / or trigger one
7. send photo reply to reminder
8. verify latest batch wins
9. reply `post now`
10. verify candidate publishes and no duplicate Hermes conversational response appears

---

## Cleanup tasks after rollout

- remove `createTelegramUpdatePoller` from active production path
- remove auto-biographer dependence on `TELEGRAM_CONTROL_BOT_TOKEN` for ingress
- remove candidate-row `telegram_message_id` after migration period
- document the single-bot architecture in:
  - `README.md`
  - `docs/superpowers/specs/2026-04-14-auto-biographer-design.md`

---

## Notes for execution

- Do not attempt this as one giant patch.
- Keep Hermes and auto-biographer changes shippable in slices.
- Preserve current Telegram message format until the routing is stable.
- Prefer adding an inbox/outbox queue over ad hoc subprocess handshakes.
- The first safe milestone is: Hermes still owns polling, auto-biographer no longer does, and replies/photos are routed by control-message mapping.
