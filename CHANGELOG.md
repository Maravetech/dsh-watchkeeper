# Changelog

## Unreleased — security hardening

- S1: Reject non-loopback HTTP `Host` values by default, `Origin: null`, and cross-site requests without an `Origin`. Permit the known DSH desktop schemes and allow explicit trusted hosts through `WATCHKEEPER_ALLOWED_HOSTS`. `/watchkeeper/watch/prompt` no longer lets `force` bypass the global stop or takeover gate; delivery checks the gate again.
- H1: Fallback replies now refuse every `red-line:*` result, `judge-unavailable`, `judge-irreversible`, and context that hits the red-line classifier. The earlier free-text and multi-select fallback eligibility remains unchanged for safe contexts.
- H2: A task ID alone no longer authorizes takeover. An unexpired, matching operator record in `task-grants.json` is required; the lease is bounded by the grant and live execution checks the record again after revocation.
- Breaking behavior: callers relying on `force`, `Origin: null`, or unregistered task IDs must update. No live DSH deployment or runtime verification is implied by this source change.

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
