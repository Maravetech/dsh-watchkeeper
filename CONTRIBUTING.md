# Contributing

Thanks for helping. This project is small and stays small on purpose.

## Requirements

- Node.js 22.5 or newer
- No dependencies. The plugin and the tests use Node built-ins only.

## Setup

```bash
git clone https://github.com/Maravetech/dsh-watchkeeper.git
cd dsh-watchkeeper
node --version
```

There is no install step. Do not add a package manager lockfile unless the project starts using dependencies.

## Run the tests

```bash
npm test
```

Run one file while iterating:

```bash
node --test tests/answers-card.test.mjs
```

Run a test file with the built-in runner reporter when a failure is hard to read:

```bash
node --test --test-reporter=spec tests/host.test.mjs
```

Tests must pass before a pull request is opened. A behavior change without a test is not ready.

## Layout

| Path | Role |
| --- | --- |
| `index.js` | Package entry. Loads the host half. |
| `lib/host.js` | Host half: features, routes, lifecycle. |
| `lib/features/` | One feature per file: numbers, answers, providers, watch. |
| `lib/watch/` | Watch engine: leases, decision records, locks, judgment. |
| `client.js` | Browser half: session-number column, decision cards, pending answers. |
| `locale/` | User-facing strings. Both locales must stay in sync. |
| `tests/` | Node test runner files. |
| `docs/` | User documentation. |

## Change rules

- Keep the default safe. No judge configured means every question goes to a human. Never change that default.
- Red lines stay hard. Credentials, money and irreversible actions must always hand off to a human. Do not route them through a judge, a reply provider or a test fixture.
- A failed judge, provider or parser must degrade to "human decides", never to a silent automatic answer.
- Keep the state format backward compatible. If you must change it, add a migration and a test.
- User-facing text goes through `locale/`, not hard-coded strings.
- New behavior needs a test that fails before the change and passes after it.

## Pull requests

- One topic per pull request.
- Describe what changed, why, and how it was verified.
- Include the test command and its result.
- Update `docs/` when configuration, commands or file formats change.
- Do not commit credentials, tokens, personal paths or state files.

## License

Contributions are accepted under the MIT license. See [LICENSE](LICENSE).
