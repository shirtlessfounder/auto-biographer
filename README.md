# auto-biographer

Auto-biographer turns recent activity into reviewable X posts.

It pulls signal from things like Slack, GitHub, Innies conversations, and X context, builds a fresh context packet, runs Hermes to select the best posting opportunity, drafts the post, sends it to Telegram for control, and publishes to X when approved or due.

## Current State

- Live, single-user system running on EC2
- X is the only publishing target today
- Telegram is the control surface for review, edit, hold, skip, and post-now
- Hermes is used for both selection and drafting
- GitHub, Slack, Innies, and X quote-target context feed the selector
- Optional Telegram photo replies can be attached at publish time
- Publishing records source usage so the system avoids recycling the same context repeatedly

## Flow

```mermaid
flowchart TD
    A[Recent activity<br/>Slack messages + links<br/>GitHub events<br/>Innies conversations<br/>X quote-target context]
    B[Normalize and persist events]
    C[Build recent context packet]
    D[Hermes selector]
    E[Chosen candidate]
    F[Hermes drafter]
    G[Candidate stored in DB]
    H[Telegram draft package]
    I{Telegram or scheduler}
    J[Edit / hold / skip]
    K[Publish to X]
    L[Record published post<br/>and source usage]

    A --> B --> C --> D --> E --> F --> G --> H --> I
    I -->|edit / hold / skip| J --> H
    I -->|post now or deadline| K --> L
```

## Local Setup

```bash
cd /Users/dylanvu/auto-biographer
pnpm install
```

Copy `.env.example` into your local environment before running commands.

## Commands

```bash
pnpm test
pnpm typecheck
pnpm cli -- migrate
pnpm cli -- draft-now
pnpm cli -- tick
```
