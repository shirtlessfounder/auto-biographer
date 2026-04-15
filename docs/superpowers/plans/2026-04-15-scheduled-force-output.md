# Scheduled Force Output Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make scheduled cron/jitter runs always produce a Telegram draft when there is usable recent context, even if the selector returns `skip`.

**Architecture:** Keep Hermes selector behavior unchanged. Add deterministic scheduled-only fallback logic in the orchestrator so scheduled runs convert selector skips into a selected candidate built from the strongest recent first-party event, then continue through the existing drafter and Telegram flow. Manual and on-demand flows keep current skip behavior.

**Tech Stack:** TypeScript, Vitest, Postgres-backed repositories, Telegram packaging pipeline

---

### Task 1: Lock the scheduled fallback behavior in tests

**Files:**
- Modify: `tests/integration/orchestrator/tick.test.ts`

- [ ] **Step 1: Write the failing test**
Add an integration case where a scheduled slot has recent first-party context, the selector returns `skip`, and the system still creates a pending-approval candidate and sends one Telegram candidate package.

- [ ] **Step 2: Run the test to verify it fails**
Run: `pnpm vitest tests/integration/orchestrator/tick.test.ts -t "falls back from a scheduled selector skip"`

- [ ] **Step 3: Confirm failure mode**
Expected: current code finalizes the candidate as `selector_skipped` and sends a plain skip notification instead of a candidate package.

### Task 2: Add scheduled-only fallback selection

**Files:**
- Modify: `src/orchestrator/tick.ts`
- Modify: `src/orchestrator/select-candidate.ts`

- [ ] **Step 1: Build a scheduled fallback helper**
Create a helper that inspects the already-built recent context packet and promotes the strongest recent event into a synthetic selected candidate when scheduled runs get a selector skip.

- [ ] **Step 2: Keep manual behavior unchanged**
Ensure only `triggerType === "scheduled"` uses the fallback path; other trigger types should keep existing skip semantics.

- [ ] **Step 3: Reuse the existing draft/delivery pipeline**
Feed the fallback selection into `draftSelectedCandidate()` so Telegram delivery, reminders, and later approval/posting behavior stay unchanged.

### Task 3: Verify the regression and surrounding behavior

**Files:**
- Modify: `tests/integration/orchestrator/tick.test.ts` if needed for adjacent assertions

- [ ] **Step 1: Run focused integration coverage**
Run: `pnpm vitest tests/integration/orchestrator/tick.test.ts`

- [ ] **Step 2: Run broader verification**
Run: `pnpm test`
Run: `pnpm typecheck`

- [ ] **Step 3: Confirm unchanged skip behavior elsewhere**
Verify non-scheduled selector skips still produce a skip candidate and plain Telegram notification.
