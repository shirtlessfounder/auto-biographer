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
- `quote_target`, `suggested_media_kind`, and `suggested_media_request` must be `null` when unused.
