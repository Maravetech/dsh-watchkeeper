# Changelog

## Unreleased

- Accept the known DSH desktop shell origins on loopback HTTP routes, while rejecting `Origin: null` and browser cross-site requests without an Origin. The separate control token requirement remains in force.
- Recheck the global stop gate after asynchronous session activation and immediately before either prompt delivery path. A stop raised during activation now prevents delivery and returns 409 from the HTTP prompt route.

## 0.2.0 — alpha

Security fixes from an independent review of 0.1.2. Upgrade from any earlier version.

Breaking:

- Watch control `POST` routes now require a separate bearer token in `WATCHKEEPER_CONTROL_TOKEN`, sent as `x-watchkeeper-control-token`. Unset means those routes return 403. The DSH web UI does not call them, so the UI keeps working.
- The request `Host` must be a literal loopback address (`127.0.0.1`, `[::1]`, `localhost`).

Security:

- S1: A page whose `Origin` matched a spoofed `Host` (DNS rebinding) passed the origin check, and `force: true` on `/prompt` bypassed the STOPPED stop gate. Origins are now checked against loopback, `force` is gone, and `promptSession()` checks the global gate itself.
- H1: The fallback reply provider could answer red-line questions marked delete or publish, and questions where the judge was unavailable. Fallback now refuses every `red-line:*`, `judge-unavailable`, free-text and multi-select question.
- H2: Any non-empty `taskId` counted as task authorization and could lift a channel session exclusion. Self-asserted task IDs are now rejected. A verifier for trusted task records is not implemented yet.
- M4: Client reports are reduced to a field allowlist without page HTML, and new state files are written `0600` in `0700` directories. Not every existing state file is migrated to the new modes yet.

Fixes:

- H4: Decision-lock heartbeat renewal always failed (arguments swapped) and the error was swallowed.
- M2: The session-number ledger lost updates when two instances wrote at once; assignment now locks and reloads.
- M3: A corrupt lease or operation file was silently replaced by an empty state; it is now preserved and reported.
- M5: CI actions pinned to commit SHAs, with `permissions: contents: read`.
- L1: README and docs now match the control, fallback and shell-execution behavior.

49 tests.

## 0.1.2 — alpha

Packaging, following the DSH bundle guide (`docs/user/develop/basic/publish.md` in deepseek-ai/deepseek-harness):

- Declare `engines.dsh: ">=0.2.0-rc.1 <0.3.0"`. Verified: accepted by DSH 0.2.2-rc.1, and `dsh --dump-config` shows the `dsh-watchkeeper` layer.
- Add the `dsh-plugin` npm keyword.
- Each release now ships a `pnpm pack` tarball, installable with `dsh plugin add ./dsh-watchkeeper-<version>.tgz`.
- README: tarball install, commit pinning, supported DSH versions.

## 0.1.1 — alpha

Security:

- HTTP routes no longer reflect any `Origin` in CORS headers. Before this fix, a web page on any origin could call the routes from the user's browser, including `POST /watchkeeper/watch/prompt`, which sends text into a session. Browser requests are now allowed only from the DSH web UI's own origin and from `WATCHKEEPER_ALLOWED_ORIGINS`; others get 403. Upgrade from 0.1.0.
- Request bodies on the watch routes are capped at 256 KB.

Install:

- Install with `dsh plugin --profile <profile> add github:Maravetech/dsh-watchkeeper#v0.1.1`. The plugin registers itself as a profile bundle; no `cordis.patch.yml` edit or symlink is needed.
- The skill link now points into the installed package.

Other:

- Removed references to the authors' internal documents from code comments.
- 36 tests.

## 0.1.0 — alpha

First public release.

- Session numbers: a stable number per session, shown in the session list.
- Pending answers: human decision cards are collected, answered in one place, and delivered back to the source session.
- Watch loop: a pluggable judge command answers routine mid-session questions; uncertain, red-line and failed cases go to a human.
- Reply providers `codex`, `agy` and `custom`, all off by default.
- Vendored version adapter and reply normalization; no runtime dependency outside Node built-ins.
- 31 tests, GitHub Actions workflow.

Known limits:

- Not on npm yet; install from this repository.
- `decision: "continue"` from a judge is reserved; it currently hands the card to a human.
- The screenshot in the README is a placeholder.
