// Session numbering provider — a stable number for every session.
//
// The ledger is a plain JSON file under $WATCHKEEPER_HOME. Numbers are assigned
// on first sight of a session and never reused, so the sidebar column is stable
// across restarts. A session that produces no events is simply not numbered yet.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEGRADE } from '../dsh-compat/features.js'
import { withFileLock } from '../watch/store.js'

export const id = 'numbers'
export const title = 'Session numbers'
export const paths = ['/watchkeeper/numbers/state', '/watchkeeper/numbers/refresh']
export const order = 10

export const defaults = {
  enabled: true,
  /** Ledger file. Relative paths resolve against WATCHKEEPER_HOME. */
  ledger: null,
}

function safeTitle(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : null
}

export function numberFor(entry) {
  const n = entry && entry.n
  return n == null ? null : String(n)
}

export function toRows(ledger) {
  const numbers = ledger && typeof ledger.numbers === 'object' ? ledger.numbers : {}
  return Object.entries(numbers)
    .map(([sessionId, entry]) => ({
      sessionId,
      n: numberFor(entry),
      title: entry?.title || null,
      workspace: entry?.workspace || null,
    }))
    .filter(row => row.n != null)
    .sort((a, b) => Number(a.n) - Number(b.n))
}

export function createFeature({ compat, config, log }) {
  const ledgerFile = config.ledger
    ? path.resolve(compat.core, config.ledger)
    : path.join(compat.core, 'numbers.json')
  let ledger = { updated_at: null, numbers: {} }
  let loaded = false
  let error = null

  function readLedger() {
    try {
      const raw = JSON.parse(readFileSync(ledgerFile, 'utf8'))
      ledger = { updated_at: raw?.updated_at || null, numbers: raw?.numbers && typeof raw.numbers === 'object' ? raw.numbers : {} }
      error = null
    } catch (cause) {
      if (cause?.code !== 'ENOENT') error = String(cause?.message ?? cause)
    }
    loaded = true
    return ledger
  }

  function saveLedger() {
    try {
      mkdirSync(path.dirname(ledgerFile), { recursive: true, mode: 0o700 })
      const tmp = `${ledgerFile}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify(ledger, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, ledgerFile)
      chmodSync(ledgerFile, 0o600)
    } catch (cause) {
      error = String(cause?.message ?? cause)
      log({ type: 'numbers-save-failed', message: error })
    }
  }

  /** Assign the next free number to a session; keep the title up to date. */
  function touch(sessionId, title = null) {
    if (!sessionId) return
    return withFileLock('numbers', () => {
    readLedger() // The cached copy can be stale in another DSH process.
    if (error) { log({ type: 'numbers-read-failed', message: error }); return }
    let changed = false
    const entry = ledger.numbers[sessionId]
    if (!entry) {
      const max = Object.values(ledger.numbers).reduce((acc, row) => Math.max(acc, Number(row?.n) || 0), 0)
      ledger.numbers[sessionId] = { n: max + 1, title: safeTitle(title), workspace: null }
      changed = true
    } else if (title && entry.title !== safeTitle(title)) {
      entry.title = safeTitle(title)
      changed = true
    }
    if (changed) {
      ledger.updated_at = new Date().toISOString()
      saveLedger()
    }
    }, { dir: path.dirname(ledgerFile) })
  }

  return {
    id,
    title,
    paths,
    order,
    start() {
      if (config.enabled === false) return
      readLedger()
      compat.on('session/event', (session, event) => {
        if (!session?.id) return
        const nextTitle = event?.type === 'session/title' ? event.data?.title : null
        touch(session.id, nextTitle)
      })
    },
    dispose() { /* no timers */ },
    state() {
      if (config.enabled === false) return { ...DEGRADE.disabled, rows: [] }
      if (!loaded) readLedger()
      const rows = toRows(ledger)
      return {
        ok: !error,
        at: new Date().toISOString(),
        updatedAt: ledger.updated_at,
        count: rows.length,
        rows,
        ledger: ledgerFile,
        error: error || undefined,
      }
    },
    action(name) {
      if (name === 'refresh') { readLedger(); return { ok: true, started: false, state: this.state() } }
      return { ok: false, error: `Unknown action: ${name}` }
    },
  }
}
