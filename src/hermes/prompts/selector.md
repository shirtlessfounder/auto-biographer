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
- Treat `action:repo_created` as a top-tier project-start signal. Prefer it over routine pushes or branch-created noise when freshness and specificity are comparable.
- `suggested_media_kind` and `suggested_media_request` must be `null` when unused.
- Avoid choosing a candidate that is too similar in angle, text, or quote target to `recentPublishedPosts` or `pendingApprovalCandidates`.
