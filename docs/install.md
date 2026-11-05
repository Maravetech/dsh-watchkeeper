# Install dsh-watchkeeper

Two installs: the plugin and the skill. Do both. The plugin makes DSH number sessions and collect decision cards. The skill tells an agent how to use them.

> Alpha (v0.1). The package is not on npm yet. Install from a local clone.

## Before you start

- Node.js 22.5 or newer: `node --version`
- A DSH profile. Inside a DSH session these variables are already set:
  - `DSH_HOME` — usually `~/.dsh`
  - `DSH_PROFILE_DIR` — the current profile directory
  - `DSH_WEB_URL` — the app URL, for example `http://127.0.0.1:62630`

Outside a DSH session, replace them with your real paths.

## Part 1 — Install the plugin

### Step 1. Clone the repository

```bash
git clone https://github.com/Maravetech/dsh-watchkeeper.git
cd dsh-watchkeeper
```

Keep the clone where it is. The next step links to it; moving it later breaks the link.

### Step 2. Link the package into the profile

```bash
mkdir -p "$DSH_HOME/profiles/node_modules"
ln -s "$PWD" "$DSH_HOME/profiles/node_modules/dsh-watchkeeper"
```

`$DSH_HOME/profiles/node_modules` is the shared module root for all profiles. If the link already exists, remove it first: `rm "$DSH_HOME/profiles/node_modules/dsh-watchkeeper"`.

### Step 3. Add the loader line

Open `$DSH_PROFILE_DIR/cordis.patch.yml` and add:

```yaml
- insert:
    - id: dsh-watchkeeper
      name: 'dsh-watchkeeper'
```

If the file already has an `- insert:` block, add the two lines under it. Keep the YAML indentation exactly as shown.

### Step 4. Restart DSH

Quit the app completely and start it again. The host half of a plugin loads once at app start; a page reload is not enough.

### Step 5. Verify

```bash
curl -s "$DSH_WEB_URL/watchkeeper/health" | python3 -m json.tool
```

A working install returns JSON with `"ok": true` and a `features` array that includes `numbers`, `answers`, `providers` and `watch`.

Also check the session list. Each session row should show a number at its start.

If the endpoint returns 404, the route was not mounted. Check the loader line indentation and restart again.

## Part 2 — Install the skill

```bash
mkdir -p "$DSH_HOME/skills"
ln -s "$PWD/skills/dsh-watchkeeper" "$DSH_HOME/skills/dsh-watchkeeper"
```

Verify the link points at a real file:

```bash
ls -l "$DSH_HOME/skills/dsh-watchkeeper/SKILL.md"
```

Restart DSH or reload the agent session so the skill list refreshes.

## Upgrade

```bash
cd "$(readlink "$DSH_HOME/profiles/node_modules/dsh-watchkeeper")"
git pull
```

Restart DSH. If the clone path changed, remove the old symlinks and create them again:

```bash
rm "$DSH_HOME/profiles/node_modules/dsh-watchkeeper"
rm "$DSH_HOME/skills/dsh-watchkeeper"
```

## Uninstall

1. Remove the loader line from `$DSH_PROFILE_DIR/cordis.patch.yml`.
2. Remove the links:

```bash
rm "$DSH_HOME/profiles/node_modules/dsh-watchkeeper"
rm "$DSH_HOME/skills/dsh-watchkeeper"
```

3. Restart DSH.

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
