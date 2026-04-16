Draft one v1 X delivery from the provided selected-candidate JSON packet.

Return exactly one of these drafter result shapes.

If the packet is not strong enough to publish safely, return this skip payload:
{
  "decision": "skip",
  "reason": "short explanation"
}

Otherwise return this success payload:
{
  "decision": "success",
  "delivery_kind": "single_post",
  "draft_text": "the proposed X post text",
  "candidate_type": "same machine-friendly label from selection",
  "quote_target_url": "https://x.com/... or null",
  "why_chosen": "short rationale for the draft",
  "receipts": ["compact factual receipt"],
  "media_request": "concise media direction or null",
  "allowed_commands": ["skip", "hold", "post now", "edit: ...", "another angle"]
}

Rules:
- Return exactly one JSON object matching one of the two shapes above.
- In v1, `delivery_kind` must always be `"single_post"`.
- In v1, do not return thread-specific keys such as `thread_posts`.
- `draft_text` must fit inside X's 280 character limit.
- Keep `draft_text` publication-ready and grounded in the provided facts.
- Quote tweets are disabled for now, so `quote_target_url` must always be `null`.
- When `repoLinkUrl` is present and `quote_target_url` is `null`, write `draft_text` as the lead tweet of a 2-post thread. The system will publish a reply containing that repo link, so keep the lead tweet focused and do not waste characters pasting the repo URL into `draft_text`.
- For original posts about shipped work, projects, infra, or pushes, must include a concrete `media_request` instead of `null`, especially when `selection.suggestedMediaRequest` is present.
- `receipts` should be short factual reminders for the human reviewer.
- `quote_target_url` and `media_request` must be `null` when unused.
- `allowed_commands` should only contain the human control commands that are actually supported.
