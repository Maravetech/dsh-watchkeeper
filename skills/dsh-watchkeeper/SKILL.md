---
name: dsh-watchkeeper
description: Install, configure and use dsh-watchkeeper, the DSH plugin that numbers sessions, collects human decision cards and can auto-answer mid-session questions with a pluggable judge. Use when enabling the plugin, writing a [DECISION_POINT] card that must register, or troubleshooting missing cards or unexpected automatic answers.
---

# dsh-watchkeeper (值守)

This skill is the operator's guide to dsh-watchkeeper. It covers four jobs: install it, configure it, write decision cards it will accept, and diagnose why a card or an automatic answer did not happen.

## When to use

- Enabling the plugin on a DSH profile.
- Turning on a judge or a reply provider.
- Asking a human for a decision from inside a session.
- A card does not appear, or a question that should be automatic went to a human.

## Install and enable

1. Clone and link the package:

```bash
git clone https://github.com/Maravetech/dsh-watchkeeper.git
ln -s "$PWD/dsh-watchkeeper" "$DSH_HOME/profiles/node_modules/dsh-watchkeeper"
```

2. Add the loader line to the profile:

```yaml
- insert:
    - id: dsh-watchkeeper
      name: 'dsh-watchkeeper'
```

3. Restart DSH completely. The host half loads at app start; a page reload is not enough.

4. Check health:

```bash
curl -s "$DSH_WEB_URL/watchkeeper/health" | python3 -m json.tool
```

Expect `"ok": true` and a `features` list containing `numbers`, `answers`, `providers` and `watch`.

5. Link this skill, if it is not linked yet:

```bash
ln -s "$PWD/dsh-watchkeeper/skills/dsh-watchkeeper" "$DSH_HOME/skills/dsh-watchkeeper"
```

## Configure

All settings are environment variables. Put them where DSH is launched, then restart DSH.

| Variable | Default | Effect |
| --- | --- | --- |
| `WATCHKEEPER_HOME` | `~/.dsh-watchkeeper` | State, session-number ledger, provider switches, SQLite database. |
| `WATCHKEEPER_JUDGE_CMD` | unset | Judge command (executable or shell command). Unset means every question goes to a human. |
| `WATCHKEEPER_CODEX_BIN` / `WATCHKEEPER_AGY_BIN` / `WATCHKEEPER_CUSTOM_CMD` | unset | Reply provider binaries. |

The judge reads one JSON line from stdin. Input:

```json
{"sessionId":"s-1","question":"…","header":"…","context":"…","options":["first","second"],"thresholds":{"approve":0.7}}
```

It writes one JSON line to stdout. Output:

```json
{"decision":"answer","selected":"first","confidence":0.9,"reason":"read-only choice"}
```

`decision` must be `answer` in v0.1; `human` and `continue` are reserved and currently hand the question to you. `selected` must be one of `options` verbatim. Any failure — non-zero exit, timeout, invalid JSON, unknown option, confidence below the threshold — hands the question to a human.

Reply providers (`codex`, `agy`, `custom`) only write the reply text. They are off by default; switches live in `$WATCHKEEPER_HOME/providers.json`. With all providers off, the selected option is sent as the answer.

Details: `docs/configuration.md` in this repository.

## Write a decision card

A card is one JSON object between `[DECISION_POINT]` and `[/DECISION_POINT]`. In a real message it must sit outside code fences and blockquotes.

The example below is fenced for readability only. Emit the wrapper outside any fence.

```text
[DECISION_POINT]{"audience":"human","requires_user_response":true,"human_review":[{"question_id":"q-1","question":"Publish with the current image or wait for a new one?","type":"卡点","reason":"The new image is not approved.","manual_reason":"必要信息","blocking_scope":"Publishing is blocked.","attempts":["Checked the asset folder twice."],"background":"The current image is usable but older.","recommendation":"Publish with the current image.","options":["Publish with the current image","Wait for the new image"],"state":"needs_user","audience":"human","requires_user_response":true,"agent_can_resolve":false,"already_resolved":false}]}[/DECISION_POINT]
```

Rules that matter most:

- Top level: `audience` is `human`, `requires_user_response` is `true`, `human_review` holds the questions.
- Every question needs `question_id`, `question`, `type`, `reason`, `manual_reason`, `blocking_scope`, `attempts`, `background`, `recommendation`, `state`, `audience`, `requires_user_response`, `agent_can_resolve`, `already_resolved`.
- `type` is one of `卡点`, `口径`, `冲突`, `信息缺口`. `manual_reason` is one of `登录`, `资金`, `设计机制`, `必要信息`.
- `options` is optional: two to four short strings, recommended first. Bad options only drop the buttons.
- `type` = `冲突` also needs `conflicting_rules` with two or more quoted rules.
- No placeholder questions. No JSON shown as the visible message text.

Full field rules and error table: `docs/decision-cards.md` in this repository.

## Troubleshoot

Run these in order.

| Step | How | What to look for |
| --- | --- | --- |
| Health | `curl -s "$DSH_WEB_URL/watchkeeper/health" \| python3 -m json.tool` | `ok: true`; `features` complete; read `degraded` for a broken module. |
| State | `ls "$WATCHKEEPER_HOME/state"` | `leases.json`, `ops.json`, `decisions.jsonl` should appear once the plugin runs. |
| Decision trail | `tail -n 20 "$WATCHKEEPER_HOME/state/decisions.jsonl"` | Every automatic or handed-off decision is recorded here with a reason. |
| Logs | `tail -n 50 "$WATCHKEEPER_HOME/probe.log"` | JSON lines. Look for `feature-import-failed`, `judge-*`, `reply-*`. The plugin option `logFile` moves the file. |

Common causes:

- Card missing: it is inside a code fence or blockquote, missing a wrapper, or the top-level `audience` / `requires_user_response` is wrong.
- Card rejected: `type`, `manual_reason` or `state` is outside the allowed values, or `attempts` is empty.
- No automatic answer: `WATCHKEEPER_JUDGE_CMD` is unset. This is the safe default.
- Judge ran but handed off: non-zero exit, timeout, bad JSON, selected option not in `options`, confidence below the threshold, or a red-line topic.
- Provider reply missing: all providers are off, the binary is not on `PATH`, or `WATCHKEEPER_CUSTOM_CMD` is unset.
- Pending answers disappeared after a restart: `WATCHKEEPER_HOME` changed. Keep it stable.

Never weaken a red-line hand-off to make a test pass. Credentials, money and irreversible actions must always reach a human.
