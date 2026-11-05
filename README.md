# dsh-watchkeeper

[![test](https://github.com/Maravetech/dsh-watchkeeper/actions/workflows/test.yml/badge.svg)](https://github.com/Maravetech/dsh-watchkeeper/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/Maravetech/dsh-watchkeeper?include_prereleases&sort=semver)](https://github.com/Maravetech/dsh-watchkeeper/releases)

**Alpha.** Version 0.2.0. The plugin API and configuration may change before 1.0.

dsh-watchkeeper is a DSH plugin that watches sessions for you. It does three things:

| Feature | What it does |
| --- | --- |
| Session numbers | Every session gets a stable number, shown at the start of its row in the session list. Numbers are not reused while the ledger is kept. |
| Pending answers | Human decision cards are collected in one place. You answer once, and the answer is delivered back to the session that asked. |
| Watch loop | A pluggable judge can answer routine mid-session questions for you. Low confidence, broken output, and red-line topics always go to a human. |

> Screenshot: session list with numbers, a decision card and the pending-answer view. Placeholder until `docs/assets/screenshot.png` is added.

## Defaults

- **No judge configured means no automatic decision-card answers.** A configured `fallbackEnabled` reply provider only handles a narrow set of uncertainty results from a judge that actually ran; red lines and unavailable judges go to a human. Optional auto-continue is a separate path.
- Reply providers are off by default.
- Authenticated DSH Web users can turn off watch or emergency-stop it without a control token. Turning it on additionally requires a private local `operator.json` opt-in. Other HTTP control writes require `WATCHKEEPER_CONTROL_TOKEN`.
- Numbering starts at 1 and goes up. A session keeps its number across restarts.

## Requirements

- Node.js 22.5 or newer
- A DSH desktop or web app with a profile

## Install

Install with DSH's own plugin command. It forwards to pnpm in the profile directory and registers the plugin as a bundle of that profile, so no manual `cordis.patch.yml` edit is needed. Not on npm yet; install from GitHub.

Two parts: the plugin (host behavior) and the skill (agent instructions).

### Plugin

```bash
dsh plugin --profile <your-profile> add github:Maravetech/dsh-watchkeeper#v0.2.0
```

To work on a local clone instead:

```bash
git clone https://github.com/Maravetech/dsh-watchkeeper.git
dsh plugin --profile <your-profile> add "file:$PWD/dsh-watchkeeper"
```

Or download `dsh-watchkeeper-<version>.tgz` from the [release page](https://github.com/Maravetech/dsh-watchkeeper/releases) and add the file:

```bash
dsh plugin --profile <your-profile> add ./dsh-watchkeeper-0.2.0.tgz
```

For a fixed install, pin a commit instead of a tag: `github:Maravetech/dsh-watchkeeper#<commit-sha>`. The package is plain JavaScript with no build step, so no `allowBuilds` entry is needed.

Supported DSH versions are declared in `engines.dsh` (currently `>=0.2.0-rc.1 <0.3.0`); `dsh plugin add` refuses other versions.

Remove it with `dsh plugin --profile <your-profile> remove dsh-watchkeeper`.

Restart DSH completely, then check the health endpoint:

```bash
curl -s "$DSH_WEB_URL/watchkeeper/health" | python3 -m json.tool
```

If `DSH_WEB_URL` is not set, use the port from the app's URL, for example `http://127.0.0.1:62630/watchkeeper/health`.

### Skill

```bash
ln -s "$DSH_PROFILE_DIR/node_modules/dsh-watchkeeper/skills/dsh-watchkeeper" "$DSH_HOME/skills/dsh-watchkeeper"
```

To install only the skill into other agents (Claude Code, Codex and others) through [skills.sh](https://skills.sh) (Vercel `skills` CLI, Node 22.20+):

```bash
npx skills add Maravetech/dsh-watchkeeper --skill dsh-watchkeeper -g
```

The skill only explains the plugin; it does nothing unless the plugin above is installed in DSH.

Full instructions, including upgrades and uninstall: [docs/install.md](docs/install.md).

## Documentation

| Document | Covers |
| --- | --- |
| [docs/install.md](docs/install.md) | Plugin and skill install, upgrade, uninstall |
| [docs/configuration.md](docs/configuration.md) | Environment variables, the judge contract, providers |
| [docs/decision-cards.md](docs/decision-cards.md) | Card JSON, options, common mistakes |

## Configure

Settings are environment variables. The three that matter most:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WATCHKEEPER_HOME` | `~/.dsh-watchkeeper` | Where state, the session-number ledger and the SQLite database live. |
| `WATCHKEEPER_JUDGE_CMD` | unset | Judge command. Unset means every question goes to a human. |
| `WATCHKEEPER_CONTROL_TOKEN` | unset | Separate bearer token for scripts and other watch control POST routes. The authenticated Web switch has a narrower local opt-in path. |
| `WATCHKEEPER_CODEX_BIN` / `WATCHKEEPER_AGY_BIN` / `WATCHKEEPER_CUSTOM_CMD` | unset | Reply provider binaries. |

The full list, the judge contract and the provider commands: [docs/configuration.md](docs/configuration.md).

### Control writes for a new installation

Session numbering, watch state reads, and the pending-answer view do not need a control token. The authenticated DSH Web page now has a per-session switch above the input and an emergency-stop button. Turning watch off or stopping it needs no bearer token. Turning watch on additionally requires a private `$WATCHKEEPER_HOME/operator.json` containing `{"allowUiEnable":true}`; without it the server returns 409. A global STOPPED state also refuses enable (409). The stop button persists STOPPED and disables active leases; there is no UI reset route.

The Web UI path requires a literal loopback Host, its exact same Origin, `Sec-Fetch-Site: same-origin`, and DSH's authenticated browser Peer. Desktop request headers have not been verified, so desktop UI control is disabled. External web pages fail the origin checks. A local Agent that can run commands can still modify the opt-in file or drive/impersonate the local browser; this switch is not a boundary against local code execution. This design follows fenn's 2026-11-05 switch decision.

To opt in from a POSIX shell, create the file outside Git with private permissions:

```bash
umask 077
mkdir -p "$HOME/.dsh-watchkeeper"
printf '%s\n' '{"allowUiEnable":true}' > "$HOME/.dsh-watchkeeper/operator.json"
```

All other `POST /watchkeeper/watch/*` requests (`provider`, `prompt`, `decide`, `beacon`, `sweep`, `recover`) still need `WATCHKEEPER_CONTROL_TOKEN`. Scripts and tools also need it for `toggle` and `stop`; matching request headers without DSH browser authentication do not grant the UI path. With the token unset, these token-only writes return 403. A token configured only in your terminal does not reach DSH if DSH was launched elsewhere.

For a CLI-launched Web profile, create a private token file and pass its value in the environment that starts DSH:

```bash
umask 077
openssl rand -hex 32 > "$HOME/.dsh-watchkeeper-control-token"
export WATCHKEEPER_CONTROL_TOKEN="$(cat "$HOME/.dsh-watchkeeper-control-token")"
dsh web --no-open
```

Keep the token file outside Git and do not print its value. Authorized script calls send it in `x-watchkeeper-control-token`; the Web page never receives it. See [configuration.md](docs/configuration.md#web-switch-and-emergency-stop).

## Decision cards

A decision card is one JSON payload wrapped in `[DECISION_POINT]` and `[/DECISION_POINT]`, placed outside code fences. The plugin reads it, shows the question in the pending-answer view, and delivers your answer back to the session.

Minimal shape:

```json
{
  "audience": "human",
  "requires_user_response": true,
  "human_review": [
    {
      "question_id": "q-1",
      "question": "Ship with the current cover image or wait for the new one?",
      "type": "卡点",
      "reason": "The new image is not approved yet.",
      "manual_reason": "必要信息",
      "blocking_scope": "Publishing is blocked until this is answered.",
      "attempts": ["Checked the asset folder; the new image is still missing."],
      "background": "The current image is usable but older.",
      "recommendation": "Ship with the current image.",
      "options": ["Ship with the current image", "Wait for the new image"],
      "state": "needs_user",
      "audience": "human",
      "requires_user_response": true,
      "agent_can_resolve": false,
      "already_resolved": false
    }
  ]
}
```

Field rules, options, examples and common mistakes: [docs/decision-cards.md](docs/decision-cards.md).

## Troubleshooting

Start with the health endpoint:

```bash
curl -s "$DSH_WEB_URL/watchkeeper/health" | python3 -m json.tool
```

Then check state:

```bash
ls "$WATCHKEEPER_HOME"          # default: ~/.dsh-watchkeeper
ls "$WATCHKEEPER_HOME/state"
```

Then read the plugin log:

```bash
tail -n 50 "$WATCHKEEPER_HOME/probe.log"
```

If a card does not show up, the message usually has the card inside a code fence, missing the `[DECISION_POINT]` wrapper, or missing a required field. See [docs/decision-cards.md](docs/decision-cards.md#common-mistakes).

## Development

```bash
node --version   # must be >= 22.5
npm test
```

The test suite uses Node's built-in test runner and needs no dependencies. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
