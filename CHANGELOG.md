# Changelog

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
