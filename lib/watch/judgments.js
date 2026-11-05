// CODEX: Load the project-owned judge noul/score/choice definitions from one registry.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './paths.js'

const REGISTRY_FILE = join(ROOT, 'config', 'judgments.json')

export function loadJudgmentProfile(project = 'default') {
  try {
    const registry = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
    return { ...(registry.default ?? {}), ...(registry[String(project)] ?? {}) }
  } catch {
    return {
      completion: 'The task is fully complete and has checkable evidence.',
      blocked: 'The task cannot continue without human-only input.',
      quality: { blocked: 'Blocked', partial: 'Incomplete', ready: 'Ready to continue' },
    }
  }
}

export { REGISTRY_FILE }
