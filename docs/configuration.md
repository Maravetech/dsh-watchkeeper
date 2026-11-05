# Configuration

All configuration is environment variables, plus two optional plugin-config keys. Everything the plugin persists lives under `WATCHKEEPER_HOME`.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `WATCHKEEPER_HOME` | `~/.dsh-watchkeeper` | Root directory for state, the session-number ledger, provider switches and the SQLite database. |
| `WATCHKEEPER_STATE_DIR` | `$WATCHKEEPER_HOME/state` | Runtime state for the watch engine. Override it to isolate a test run. |
| `WATCHKEEPER_ALLOWED_ORIGINS` | unset | Extra browser origins allowed to call the plugin's HTTP routes, comma-separated, exact match. The request Host must still be a literal loopback address. This list does not authorize token-free UI writes. A request without Origin is accepted only when it is not marked `Sec-Fetch-Site: cross-site`. `Origin: null` and unmeasured desktop origins are rejected. |
| `WATCHKEEPER_CONTROL_TOKEN` | unset | Bearer token sent as `x-watchkeeper-control-token` for script and other `/watchkeeper/watch/*` POST calls. The authenticated Web `toggle` and `stop` have a separate, narrower path. Keep the token outside Git and logs. |
| `WATCHKEEPER_JUDGE_CMD` | unset | Trusted judge shell command. When unset, decision-card auto-answer is disabled. |
| `WATCHKEEPER_CODEX_BIN` | `codex` on `PATH` | Codex CLI binary used by the `codex` reply provider. |
| `WATCHKEEPER_AGY_BIN` | `agy` on `PATH` | Antigravity CLI binary used by the `agy` reply provider. |
| `WATCHKEEPER_CUSTOM_CMD` | unset | Shell command used by the `custom` reply provider. Required when `custom` is enabled. |
| `WATCHKEEPER_CONSTRAINT_GATE` | `shadow` | `shadow` records only. `on` / `enforce` apply stored constraints from earlier decisions. |

Set them in the environment that launches DSH, not in a shell that only runs `curl`.

### Web switch and emergency stop

On a new installation, watch state reads, session numbering, and the pending-answer view work without a control token. The DSH Web UI offers a per-session switch above the input and an emergency-stop button. An authenticated browser request may turn a session off or stop watchkeeper without the bearer token. Turning it on also requires `$WATCHKEEPER_HOME/operator.json` with `{"allowUiEnable":true}`. Missing, invalid, permissively readable, or non-owned operator files do not grant enable; the result is 409. Global STOPPED also rejects enable (409). No route writes operator.json.

The token-free path requires an exact loopback Web Host/Origin pair, `Sec-Fetch-Site: same-origin`, and admission as DSH's authenticated **browser** Peer. An API Peer or an unauthenticated script with copied headers is refused. `WATCHKEEPER_ALLOWED_ORIGINS` does not expand this path. Desktop `dsh://host` headers could not be captured safely in isolation and are not admitted; its UI control stays disabled until that origin is measured and reviewed. The client checks `dshDesktopBoot.ready().streamBaseUrl` before `location.origin` for its host address, but address discovery alone grants no write authority.

Emergency stop atomically writes `STOPPED` to `$WATCHKEEPER_HOME/ui-control/state.json` and disables active watch leases. The same global gate is checked before subsequent sends. There is intentionally no HTTP or UI reset route; an operator must review and clear the stop through the local control file's owner process. A session switch can still be turned off while STOPPED.

On POSIX systems, create the opt-in file outside Git with private permissions:

```bash
umask 077
mkdir -p "$HOME/.dsh-watchkeeper"
printf '%s\n' '{"allowUiEnable":true}' > "$HOME/.dsh-watchkeeper/operator.json"
```

If `WATCHKEEPER_HOME` is customized, put `operator.json` there instead. The plugin reads the file at every enable attempt. On POSIX it must be a regular, non-symlink file owned by the DSH user with mode 0600. On Windows, use the equivalent private ACL; POSIX mode checks do not apply.

This follows fenn's 2026-11-05 decision to use the on-page switch. The checks block external webpages, but cannot protect against an Agent or other local process able to run commands, edit operator.json, or control the authenticated browser. This is an explicit limit, not a claim of human-action attestation.

### Control token for scripts and other writes

Every other `POST /watchkeeper/watch/*` route requires the bearer token: `provider`, `prompt`, `decide`, `beacon`, `sweep`, and `recover`. Scripts and tools also require it for `toggle` and `stop`. If `WATCHKEEPER_CONTROL_TOKEN` is absent, token-only writes return 403 even when a caller supplies a header. A configured token still requires a matching `x-watchkeeper-control-token` header. Neither same-origin headers nor DSH Web authentication alone authorize these other writes.

For a CLI-launched Web profile:

```bash
umask 077
openssl rand -hex 32 > "$HOME/.dsh-watchkeeper-control-token"
export WATCHKEEPER_CONTROL_TOKEN="$(cat "$HOME/.dsh-watchkeeper-control-token")"
dsh web --no-open
```

Supply the variable to the process that launches the relevant DSH profile. Keep the file outside Git, restrict its permissions, and never put the value in a URL, browser storage, logs, or a committed profile file. The Web switch never receives this token.

Two plugin-config keys work as well. They sit under the watch engine in the loader entry:

- `judgeCommand` — same as `WATCHKEEPER_JUDGE_CMD`
- `judgeTimeoutMs` — judge timeout in milliseconds, default `30000`

```yaml
- insert:
    - id: dsh-watchkeeper
      name: 'dsh-watchkeeper'
      config:
        watch:
          engine:
            judgeCommand: /usr/local/bin/my-judge
            judgeTimeoutMs: 30000
```

## State directory

| Path | Contents |
| --- | --- |
| `$WATCHKEEPER_HOME/numbers.json` | Session-number ledger. One entry per session; numbers are never reused. |
| `$WATCHKEEPER_HOME/providers.json` | Reply-provider switches. |
| `$WATCHKEEPER_HOME/state/leases.json` | Per-session watch leases: rounds, token budget, expiry. |
| `$WATCHKEEPER_HOME/state/ops.json` | Decision-card transaction records. |
| `$WATCHKEEPER_HOME/state/decisions.jsonl` | Append-only decision and delivery trail. |
| `$WATCHKEEPER_HOME/state/locks/` | Cross-process locks for decision cards. |
| `$WATCHKEEPER_HOME/state/evidence/` | Snapshots kept for review. |
| `$WATCHKEEPER_HOME/ui-control/state.json` | Shared global gate; the Web emergency-stop button persists `STOPPED` here. |
| `$WATCHKEEPER_HOME/operator.json` | Private, read-only opt-in for enabling watch from the Web switch. |
| `$WATCHKEEPER_HOME/awaiting.db` | SQLite database for pending answers and question history. |
| `$WATCHKEEPER_HOME/probe.log` | Plugin log, one JSON object per line. |

Back up this directory if you care about pending answers and the decision trail. Deleting it resets numbering.

## Judge

A judge is any command that reads one question and returns one decision. A question without options is never sent to the judge. With `fallbackEnabled`, a reply provider may answer only selected uncertainty results from a judge that ran (`judge-unsure`, `judge-undecided`, `below-threshold`); no judge or any red line goes to a human. Auto-continue is separate from decision-card answering.

### Invocation

The plugin runs the trusted configured command through `/bin/sh -lc`, writes one JSON line to stdin, and reads one JSON line from stdout. Treat this setting as executable code; do not interpolate untrusted question text into the command string.

Input:

```json
{"sessionId":"s-123","question":"Ship with the current cover image or wait for the new one?","header":"Publishing","context":"The new image is not approved yet.","options":["Ship with the current image","Wait for the new image"],"thresholds":{"approve":0.7}}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | string | Source session, for your own logging. |
| `question` | string | The question to decide. |
| `header` | string | Short title; may be empty. |
| `context` | string | Trimmed, redacted excerpt. Never the full conversation. |
| `options` | string[] | Two to four options, recommended first. |
| `thresholds.approve` | number | Minimum confidence for an automatic answer. Default `0.7`. |

Output:

```json
{"decision":"answer","selected":"Ship with the current image","confidence":0.86,"reason":"Read-only choice; the current image is usable."}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `decision` | `answer` (required) | Only `answer` is accepted in v0.1. `human` and `continue` are reserved and currently hand the card to you. |
| `selected` | string | Required when `decision` is `answer`. Must match one of `options` exactly. |
| `confidence` | number | `0.0`–`1.0`. Compared with `thresholds.approve`. |
| `reason` | string | Short text for the decision trail. |

### Failure rules

Any of these hands the question to a human:

- the executable exits non-zero
- it runs longer than `judgeTimeoutMs`
- stdout is not valid JSON
- `selected` is not one of `options`
- `confidence` is below `thresholds.approve`
- no judge is configured

This is deliberate. A broken or missing judge must never turn into a silent automatic answer. Caller-supplied `taskId` is not trusted authorization; excluded channel sessions remain excluded until a trusted task-record verifier is available.

### Example judge

```bash
cat > "$HOME/judge.py" <<'PY'
#!/usr/bin/env python3
import json, sys

request = json.loads(sys.stdin.readline())
options = request.get("options") or []

if options and "read-only" in request.get("question", ""):
    print(json.dumps({
        "decision": "answer",
        "selected": options[0],
        "confidence": 0.9,
        "reason": "read-only check",
    }, ensure_ascii=False))
else:
    print(json.dumps({
        "decision": "human",
        "selected": "",
        "confidence": 0.0,
        "reason": "needs a human",
    }, ensure_ascii=False))
PY
chmod +x "$HOME/judge.py"
export WATCHKEEPER_JUDGE_CMD="$HOME/judge.py"
```

Restart DSH after setting the variable. When DSH is launched from an app icon, export it from the environment DSH inherits, or set it in the profile config as `judgeCommand`.

## Reply providers

A reply provider writes the reply text after the judge decides to answer. Three providers exist:

| ID | Command | Input |
| --- | --- | --- |
| `codex` | `codex exec -s read-only <prompt>` | Prompt as an argument; stdin is closed. |
| `agy` | `agy -p <prompt> --mode plan --print-timeout 300s` | Prompt as an argument; stdin is closed. |
| `custom` | `$WATCHKEEPER_CUSTOM_CMD` via `/bin/sh -lc` | Prompt on stdin; stdout is the reply. |

All three are off by default. With all off, the option the judge selected is sent as the answer.

Switches are stored in `$WATCHKEEPER_HOME/providers.json`:

```json
{
  "codex": false,
  "agy": true,
  "custom": false
}
```

Edit the file, then restart DSH. Turning on more than one provider makes them run in parallel; the replies are merged and delivered together, each labeled with its provider ID.

Provider failures are not silent. A failed provider is recorded in the decision trail, and the reply falls back to the selected option.

## Constraint gate

`WATCHKEEPER_CONSTRAINT_GATE` controls whether constraints learned from earlier decisions affect new ones.

| Value | Behavior |
| --- | --- |
| `shadow` (default) | Evaluate and record only. The decision is unchanged. |
| `on` | Constraints take effect. A matching constraint can turn an automatic answer into a hand-off or a request for more evidence. |
| `enforce` | Same as `on`, kept as the strictest level for fully validated constraint sets. |

With no constraint data, the gate has no effect. Start with `shadow`, review the records, then move to `on`.
