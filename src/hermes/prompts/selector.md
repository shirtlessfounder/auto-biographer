Select the single best X-post candidate from the provided JSON packet.

Return exactly one of these selector result shapes.

If nothing is fresh, specific, and safe enough to post, return this skip payload:
{
  "decision": "skip",
  "reason": "short explanation"
}

Otherwise return this select payload:
{
  "decision": "select",
  "candidate_type": "short machine-friendly label",
  "angle": "short summary of the post angle",
  "why_interesting": "why this is worth posting now",
  "source_event_ids": [1],
  "artifact_ids": [10],
  "primary_anchor": "the main factual anchor",
  "supporting_points": ["supporting fact"],
  "quote_target": "https://x.com/... or null",
  "suggested_media_kind": "image/video/chart or null",
  "suggested_media_request": "concise media direction or null"
}

Rules:
- Return exactly one JSON object matching one of the two shapes above.
- Use only ids present in the input packet.
- Keep strings concise and factual.
- `artifact_ids` may be an empty array when no artifact is needed.
- Do not choose quote tweets for now.
- `quote_target` must always be `null` until quote tweets are re-enabled.
- Prefer original observations, shipped work, project updates, and fresh agent output over commentary about someone else's post.
- **Shipped > internal.** Rank candidates by externally-visible impact. Top-tier: a feature merged to main/prod, a public launch, a domain/URL change, a new project going live, a demo-able UI. Bottom-tier: internal security hardening, refactors, lint/test cleanup, CI tweaks, dependency bumps, dotfile changes. When a shipped-to-users candidate and an internal-plumbing candidate are both available, pick the shipped one unless the shipped one is clearly stale or already posted.
- **Your own slack messages are premium signal, equal to shipped work.** `slack_message` events are author-filtered to things you personally wrote — they surface original takes, reactions, and observations that make strong biographer tweets. Weight a substantive slack message (an opinion, observation, realization, or reaction — not logistics like "gonna leave at 815") on par with shipped-to-users work. If both a fresh shipped candidate and a fresh substantive slack message are available, either can win; pick on specificity and recency. Still skip if the only fresh slack content is logistics / scheduling / quick replies / one-word answers.
- Treat `action:repo_created` as a top-tier project-start signal. Prefer it over routine pushes or branch-created noise when freshness and specificity are comparable.
- If the only fresh candidates are internal hardening / refactoring / infra chores, it is better to `skip` than to post low-signal internal work.
- `suggested_media_kind` and `suggested_media_request` must be `null` when unused.
- Avoid choosing a candidate that is too similar in angle, text, or quote target to `recentPublishedPosts` or `pendingApprovalCandidates`.
