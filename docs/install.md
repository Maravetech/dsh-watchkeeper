# Install dsh-watchkeeper

Two installs: the plugin and the skill. Do both. The plugin makes DSH number sessions and collect decision cards. The skill tells an agent how to use them.

> Alpha (v0.1). The package is not on npm yet. Install from GitHub with `dsh plugin add`.

## Before you start

- Node.js 22.5 or newer: `node --version`
- A DSH profile. Inside a DSH session these variables are already set:
  - `DSH_HOME` — usually `~/.dsh`
  - `DSH_PROFILE_DIR` — the current profile directory
  - `DSH_WEB_URL` — the app URL, for example `http://127.0.0.1:62630`

Outside a DSH session, replace them with your real paths.

## Part 1 — Install the plugin

### Step 1. Add the plugin to the profile

```bash
dsh plugin --profile <your-profile> add github:Maravetech/dsh-watchkeeper#v0.1.1
```

`dsh plugin` forwards the arguments to pnpm in the profile directory. It installs the package and adds `dsh-watchkeeper` to the profile's bundle list (`dsh.profile.bundles` in the profile's `package.json`). The plugin ships its own loader patch, so you do not edit `cordis.patch.yml`.

To develop against a local clone, add it by path instead:

```bash
git clone https://github.com/Maravetech/dsh-watchkeeper.git
dsh plugin --profile <your-profile> add "file:$PWD/dsh-watchkeeper"
```

### Step 2. Restart DSH

Quit the app completely and start it again. The host half of a plugin loads once at app start; a page reload is not enough.

### Step 3. Verify

```bash
curl -s "$DSH_WEB_URL/watchkeeper/health" | python3 -m json.tool
```

A working install returns JSON with `"ok": true` and a `features` array that includes `numbers`, `answers`, `providers` and `watch`.

Also check the session list. Each session row should show a number at its start.

If the endpoint returns 404, the route was not mounted. Check that `dsh-watchkeeper` is in the profile's bundle list and restart again.

If a browser page on another origin calls the endpoints, it gets 403. Only the DSH web UI itself, and origins listed in `WATCHKEEPER_ALLOWED_ORIGINS`, may call them from a browser. See [configuration.md](configuration.md).

## Part 2 — Install the skill

```bash
mkdir -p "$DSH_HOME/skills"
ln -s "$DSH_PROFILE_DIR/node_modules/dsh-watchkeeper/skills/dsh-watchkeeper" "$DSH_HOME/skills/dsh-watchkeeper"
```

Verify the link points at a real file:

```bash
ls -l "$DSH_HOME/skills/dsh-watchkeeper/SKILL.md"
```

Restart DSH or reload the agent session so the skill list refreshes.

## Upgrade

Add the new tag; pnpm replaces the old version:

```bash
dsh plugin --profile <your-profile> add github:Maravetech/dsh-watchkeeper#<new-tag>
```

Restart DSH.

## Uninstall

```bash
dsh plugin --profile <your-profile> remove dsh-watchkeeper
rm "$DSH_HOME/skills/dsh-watchkeeper"
```

Restart DSH.

Removing the plugin does not delete your data. Pending answers and the session-number ledger stay in `$WATCHKEEPER_HOME` (default `~/.dsh-watchkeeper`). Delete that directory only if you want to drop them:

```bash
rm -rf "$WATCHKEEPER_HOME"
```

This cannot be undone.

## Install problems

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Health endpoint returns 404 | Plugin not loaded | Check the loader line and indentation, then restart the app fully |
| Health is OK but no numbers appear | The session list has not rendered a numbered session yet | Open a session or two, then reload the page |
| `features` is missing one item | That feature failed to load | Read `degraded` in the health JSON; the message names the broken module |
| Skill does not appear | Link missing or points to a moved directory | Re-run `ls -l "$DSH_HOME/skills/dsh-watchkeeper/SKILL.md"` |
