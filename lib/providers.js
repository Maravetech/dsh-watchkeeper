// Reply-provider toggles and priority (pure logic + persistence).
//
// Each provider has its own switch, all off by default. One or several may be on:
// when several are on they run in parallel and the replies are merged (group mode).
// Toggle state is persisted under WATCHKEEPER_HOME/providers.json so it survives restarts.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homeDir } from './watch/paths.js'

/** Reply providers, in attempt order. */
export const ORDER = ['codex', 'agy', 'custom']

/** Display name and identity line used when the provider's reply is delivered. */
export const LABELS = {
  codex: { label: 'codex', identity: 'Codex: ' },
  agy: { label: 'agy', identity: 'agy: ' },
  custom: { label: 'custom', identity: 'custom: ' },
}

export function defaultState() {
  return Object.fromEntries(ORDER.map(id => [id, false]))
}

export function storePath(config = {}) {
  return config.togglesPath || path.join(homeDir(), 'providers.json')
}

/** Read toggles; a missing or broken file means "all off" (never guess). */
export function loadToggles(config = {}) {
  const state = defaultState()
  try {
    const raw = JSON.parse(readFileSync(storePath(config), 'utf8'))
    for (const id of ORDER) if (raw?.[id] === true) state[id] = true
  } catch { /* first run or unreadable file: all off */ }
  return state
}

export function saveToggles(state, config = {}) {
  const file = storePath(config)
  const clean = defaultState()
  for (const id of ORDER) if (state?.[id] === true) clean[id] = true
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch { /* keep the in-memory state usable even if the write fails */ }
  return clean
}

/** Normalize a toggle request: only known ids and booleans. */
export function normalizeToggle(state, input = {}) {
  const id = String(input.id ?? '')
  if (!ORDER.includes(id)) return { ok: false, error: `unknown provider: ${id || '(empty)'} (expected ${ORDER.join(' / ')})` }
  if (typeof input.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
  return { ok: true, state: { ...state, [id]: input.enabled } }
}

/** Enabled providers in ORDER; empty means "no takeover". */
export function activeProviders(state = defaultState()) {
  return ORDER.filter(id => state?.[id] === true)
}

/** UI view: always returns every provider with its switch state. */
export function view(state = defaultState()) {
  return ORDER.map(id => ({ id, label: LABELS[id].label, identity: LABELS[id].identity, enabled: state?.[id] === true }))
}
