# dsh-watchkeeper

[![test](https://github.com/Maravetech/dsh-watchkeeper/actions/workflows/test.yml/badge.svg)](https://github.com/Maravetech/dsh-watchkeeper/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/Maravetech/dsh-watchkeeper?include_prereleases&sort=semver)](https://github.com/Maravetech/dsh-watchkeeper/releases)

**Alpha.** Version 0.1. The plugin API and configuration may change before 1.0.

dsh-watchkeeper is a DSH plugin that watches sessions for you. It does three things:

| Feature | What it does |
| --- | --- |
| Session numbers | Every session gets a stable number, shown at the start of its row in the session list. Numbers are not reused while the ledger is kept. |
| Pending answers | Human decision cards are collected in one place. You answer once, and the answer is delivered back to the session that asked. |
| Watch loop | A pluggable judge can answer routine mid-session questions for you. Low confidence, broken output, and red-line topics always go to a human. |

> Screenshot: session list with numbers, a decision card and the pending-answer view. Placeholder until `docs/assets/screenshot.png` is added.

## Defaults

- **No judge configured means no automatic answers.** Every decision card goes to you.
- Reply providers are off by default.
- Numbering starts at 1 and goes up. A session keeps its number across restarts.

## Requirements

- Node.js 22.5 or newer
- A DSH desktop or web app with a profile

## Install

Install with DSH's own plugin command. It forwards to pnpm in the profile directory and registers the plugin as a bundle of that profile, so no manual `cordis.patch.yml` edit is needed. Not on npm yet; install from GitHub.

Two parts: the plugin (host behavior) and the skill (agent instructions).

### Plugin

```bash
dsh plugin --profile <your-profile> add github:Maravetech/dsh-watchkeeper#v0.1.1
```

To work on a local clone instead:

```bash
git clone https://github.com/Maravetech/dsh-watchkeeper.git
dsh plugin --profile <your-profile> add "file:$PWD/dsh-watchkeeper"
```

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
| `WATCHKEEPER_CODEX_BIN` / `WATCHKEEPER_AGY_BIN` / `WATCHKEEPER_CUSTOM_CMD` | unset | Reply provider binaries. |

The full list, the judge contract and the provider commands: [docs/configuration.md](docs/configuration.md).

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
