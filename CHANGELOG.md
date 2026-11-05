# Changelog

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
