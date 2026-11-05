# Decision cards

A decision card asks a human for a decision from inside an agent session. dsh-watchkeeper registers the card, shows it in the pending-answer view, and delivers the answer back to the session that asked.

## Format

Wrap one JSON object in the two markers and keep it outside code fences and blockquotes:

```
[DECISION_POINT]{"audience":"human","requires_user_response":true,"human_review":[…] }[/DECISION_POINT]
```

Rules:

- The JSON must be valid. No trailing commas, no single quotes, no comments.
- The payload must start with `{`.
- Do not put the card inside a code fence. Fenced cards are treated as examples and skipped.
- Do not put the card in a blockquote (`>`).
- Do not show the JSON as the visible message text. Write the question in plain language first, then add the card at the end.
- Put independent decisions for the same turn in one `human_review` array. Do not send a separate card per question.

## Payload

| Field | Type | Required | Value |
| --- | --- | --- | --- |
| `audience` | string | yes | Must be `human`. |
| `requires_user_response` | boolean | yes | Must be `true`. |
| `human_review` | object or object[] | yes | One question or an array of questions. |

If either top-level field is missing or wrong, the card is ignored.

## Question fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `question_id` | string | yes | Stable ID. At most 120 characters. |
| `question` | string | yes | The decision, in plain language. Must be a real question. |
| `type` | string | yes | One of `卡点`, `口径`, `冲突`, `信息缺口`. |
| `reason` | string | yes | Why this decision is needed now. |
| `manual_reason` | string | yes | One of `登录`, `资金`, `设计机制`, `必要信息`. |
| `blocking_scope` | string | yes | What stays blocked until this is answered. |
| `attempts` | string[] | yes | What the agent already tried. At least one non-empty item. |
| `background` | string | yes | Facts the human needs to decide. |
| `recommendation` | string | yes | The recommended option, with a one-line why. |
| `state` | string | yes | Must be `needs_user`. |
| `audience` | string | yes | Must be `human`. |
| `requires_user_response` | boolean | yes | Must be `true`. |
| `agent_can_resolve` | boolean | yes | Must be `false`. |
| `already_resolved` | boolean | yes | Must be `false`. |
| `revision` | integer | no | Starts at `1`. Bump it when the same question changes. |
| `options` | string[] | no | Two to four short options. Recommended first. |
| `conflicting_rules` | string[] | when `type` is `冲突` | The two or more rules that conflict, quoted. |

Most text fields are capped at 12000 characters; `question_id` is capped at 120. Keep them short.

### Types

| Type | Use when |
| --- | --- |
| `卡点` | Work cannot continue without a decision or missing fact. |
| `口径` | Two reasonable readings of a rule or definition give different results. |
| `冲突` | Two rules or requirements contradict each other. Requires `conflicting_rules`. |
| `信息缺口` | The agent lacks a fact that only the human has. |

### Options

- Two to four short strings, 120 characters or fewer each.
- Put the recommended option first.
- The human can always type a different answer. Options are a shortcut, not a constraint.
- Bad options only drop the buttons. The question itself is still registered.

## Example

````markdown
The new cover image is still in review. I can publish with the current image now, or wait for the new one.

[DECISION_POINT]{"audience":"human","requires_user_response":true,"human_review":[{"question_id":"cover-image-1","question":"Publish with the current cover image, or wait for the new one?","type":"卡点","reason":"The new image is not approved yet, and the listing is otherwise ready.","manual_reason":"必要信息","blocking_scope":"Publishing stays blocked until this is answered.","attempts":["Checked the asset folder twice; the approved file is still missing."],"background":"The current image is usable but older than the rest of the set.","recommendation":"Publish with the current image now.","options":["Publish with the current image","Wait for the new image"],"state":"needs_user","audience":"human","requires_user_response":true,"agent_can_resolve":false,"already_resolved":false}]}[/DECISION_POINT]
````

The markers in the example above are shown inside a fenced block for documentation only. In a real message, write the card outside any code fence.

## Writing a good question

- Ask for one decision. Two unrelated decisions are two items, not one sentence.
- State what is blocked. A human should see the cost of not answering.
- List what was already tried. It prevents the same question from coming back.
- Give a recommendation first. It makes the fast answer the safe answer.
- Do not use placeholder text. Questions like "please confirm the next step" are rejected.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| Card never appears | Card is inside a code fence or a blockquote | Move it outside both |
| Card never appears | Missing `[DECISION_POINT]` / `[/DECISION_POINT]` | Add both markers |
| Card never appears | Top-level `audience` is not `human`, or `requires_user_response` is not `true` | Fix both fields |
| Card is visible as raw JSON in the chat | JSON is invalid, or the markers do not wrap the object | Validate the JSON; keep the object between the markers |
| Question is rejected | `type` or `manual_reason` is outside the allowed lists | Use one of the listed values |
| Question is rejected | `state` is not `needs_user`, or `agent_can_resolve` / `already_resolved` is wrong | Copy the fixed values from the example |
| Question is rejected | `attempts` is empty or missing | List at least one concrete attempt |
| Question is rejected | `type` is `冲突` but `conflicting_rules` is missing or has fewer than two items | Quote both rules |
| Question is rejected | `question` is a placeholder phrase | Ask the real question |
| Card appears but there are no buttons | `options` is not an array of two to four short strings | Fix the options; the question still registers without them |
| Only some questions of a card appear | One card carries more than 50 questions | Split into several cards |
