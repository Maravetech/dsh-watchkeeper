// Local operator opt-in and the watchkeeper emergency stop. No HTTP write path
// can create or change operator.json. A local process with filesystem access
// can still change it; this is not a protection against a local Agent.
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { controlFile } from './control.js'
import { homeDir, uiControlDir } from './paths.js'
import { readJsonForUpdate, withFileLock, writeJsonAtomic } from './store.js'

export function operatorConfigFile() { return join(homeDir(), 'operator.json') }

export function uiEnablePermission() {
  const file = operatorConfigFile()
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return { allowed: false, reason: 'operator.json must be a regular file' }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      return { allowed: false, reason: 'operator.json must be private (mode 0600)' }
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return { allowed: false, reason: 'operator.json must be owned by the DSH user' }
    }
    const config = JSON.parse(readFileSync(file, 'utf8'))
    if (config?.allowUiEnable !== true) return { allowed: false, reason: 'operator.json must set allowUiEnable: true' }
    return { allowed: true }
  } catch {
    return { allowed: false, reason: 'operator.json is missing or invalid' }
  }
}

/** Persist STOPPED through the same global gate every send checks. No reset route. */
export function stopWatchkeeperFromUi() {
  const file = controlFile()
  return withFileLock('watchkeeper-global-stop', () => {
    // A damaged control file must remain available for diagnosis. Never
    // replace it with a fresh state just because the stop button was pressed.
    const safe = readJsonForUpdate(file, {})
    const emergency = safe.emergency && typeof safe.emergency === 'object' ? safe.emergency : {}
    writeJsonAtomic(file, {
      ...safe,
      state: 'STOPPED',
      emergency: { ...emergency, active: true, reason: 'watchkeeper-ui-stop' },
      updatedAt: new Date().toISOString(),
    })
  }, { dir: uiControlDir() })
}
