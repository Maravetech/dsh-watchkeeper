# Security

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private advisory form:

https://github.com/Maravetech/dsh-watchkeeper/security/advisories/new

Include the version, the platform, reproduction steps and the impact you expect. You will get an acknowledgement within a few days and a fix or a decision within 30 days.

## Scope

In scope:

- Automatic answers that should have gone to a human (red-line bypass).
- Reading or delivering content outside the session that asked.
- Writing state outside `WATCHKEEPER_HOME`.
- Leaking environment variables or credentials into logs or replies.

Out of scope:

- The DSH host itself.
- Optional provider binaries (`codex`, `agy`, custom commands) and what they do with a prompt.
- Anything that requires weakening the safe defaults first.

## Safe defaults

The plugin ships with no judge and no reply provider. Nothing is answered automatically until an operator configures a judge command.
