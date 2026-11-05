// Watchkeeper — path and runtime-directory resolution (single source of truth).
//
// Why a dedicated module: state files, leases, operation locks and evidence logs all
// live under one runtime directory. If each file built its own path, tests would
// eventually pollute production state (or production would read leftover fixtures).
//
// Values are functions, not constants, on purpose: a module-level constant is captured
// on first import, so switching the runtime directory inside one process would silently
// keep using the first directory.
//
// Conventions:
//   · Package root comes from WATCHKEEPER_PACKAGE_ROOT or the real file location;
//   · Runtime state defaults to ~/.dsh-watchkeeper (override with WATCHKEEPER_HOME);
//   · Every directory can be overridden by an environment variable for tests.

import os from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package root: <pkg>/lib/watch/paths.js → up three levels = <pkg>. */
export const ROOT = process.env.WATCHKEEPER_PACKAGE_ROOT
  || dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** Home for everything this plugin persists (state, evidence, sqlite DB). */
export function homeDir() {
  return process.env.WATCHKEEPER_HOME
    || join(os.homedir(), '.dsh-watchkeeper')
}

/**
 * Runtime directory for the watch engine (leases, ops, decisions).
 *
 * `WATCHKEEPER_STATE_DIR` is the test-isolation switch: regression tests must point
 * it at a temp directory, never at the real lease store.
 */
export function stateDir() {
  return process.env.WATCHKEEPER_STATE_DIR
    || join(homeDir(), 'state')
}

/**
 * Optional host control-plane directory (a UI may drop `state.json` with
 * `global: STOP | TAKEOVER | AGENT_CONTROL`). Absent file = normal operation.
 */
export function uiControlDir() {
  return process.env.WATCHKEEPER_UI_CONTROL_DIR
    || join(homeDir(), 'ui-control')
}

/**
 * File map: defined once so no module re-assembles a path by hand.
 * Getters re-read the current runtime directory on every access.
 */
export const FILES = {
  /** Leases + migration info + auto-reply ring (authoritative store). */
  get leases() { return join(stateDir(), 'leases.json') },
  /** Legacy per-session switch file: read-only migration source. */
  get legacyState() { return join(stateDir(), 'state.json') },
  /** Decision-card operation records (judging → decided → sending → committed). */
  get ops() { return join(stateDir(), 'ops.json') },
  /** Cross-process operation locks: <sessionId>__<fingerprint>.lock. */
  get locks() { return join(stateDir(), 'locks') },
  /** Decision and delivery trail (JSONL, append-only). */
  get decisions() { return join(stateDir(), 'decisions.jsonl') },
  /** Legacy handled-fingerprint file: read-only migration source. */
  get legacyHandled() { return join(stateDir(), 'handled.json') },
  /** Evidence snapshots. */
  get evidence() { return join(stateDir(), 'evidence') },
}
