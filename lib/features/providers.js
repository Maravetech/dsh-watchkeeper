// Reply-provider switches: codex / agy / custom.
//
// Each provider has its own switch, off by default. Turn on one or several; when
// several are on the replies are generated in parallel and merged (group mode).
// Toggle state is persisted, so it survives a restart.

import path from 'node:path'
import { ORDER, LABELS, activeProviders, loadToggles, normalizeToggle, saveToggles, storePath, view } from '../providers.js'

export const id = 'providers'
export const title = 'Reply takeover'
export const paths = ['/watchkeeper/providers/state', '/watchkeeper/providers/toggle']
export const order = 30

export const defaults = {
  enabled: true,
  togglesPath: null,
}

export function createFeature({ compat, config, log }) {
  const scoped = config.togglesPath ? { togglesPath: path.resolve(compat.core, config.togglesPath) } : {}
  let state = loadToggles(scoped)

  function snapshot() {
    const active = activeProviders(state)
    return {
      ok: true,
      at: new Date().toISOString(),
      enabled: config.enabled !== false,
      providers: view(state),
      active,
      /** Several enabled providers = group takeover; all of them generate in parallel. */
      takeover: active.length > 1 ? 'group' : active[0] || null,
      groupMode: active.length > 1,
      order: ORDER,
      labels: Object.fromEntries(ORDER.map(key => [key, LABELS[key]])),
      file: storePath(scoped),
    }
  }

  return {
    id,
    title,
    paths,
    order,
    start() { log({ type: 'providers-ready', file: storePath(scoped), active: activeProviders(state) }) },
    dispose() { /* 纯状态，无外部资源 */ },
    state() { return snapshot() },
    action(name, body = {}) {
      if (name !== 'toggle') return { ok: false, error: `未知动作：${name}` }
      if (config.enabled === false) return { ok: false, error: '已停用（enabled: false）' }
      const next = normalizeToggle(state, body)
      if (!next.ok) return { ok: false, error: next.error }
      state = saveToggles(next.state, scoped)
      log({ type: 'providers-toggle', id: body.id, enabled: body.enabled === true, active: activeProviders(state) })
      return { ok: true, state: snapshot() }
    },
  }
}

/** 给值守引擎用：当前该由谁接管（都关返回 null）。 */
export function currentTakeover(config = {}) {
  return activeProviders(loadToggles(config))[0] ?? null
}
