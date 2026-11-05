// Reply execution — turn "who takes over this reply" into a concrete command.
//
// Three providers:
//   · codex  — `codex exec -s read-only` (public OpenAI Codex CLI)
//   · agy    — `agy -p … --mode plan` (Google Antigravity CLI)
//   · custom — any executable configured with WATCHKEEPER_CUSTOM_CMD; the prompt
//              is written to its stdin and stdout is used as the reply
//
// Codex and agy must run with stdin closed, otherwise they wait for input and hang
// until the timeout. The custom provider is the opposite: it reads the prompt from stdin.

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { ORDER, activeProviders, loadToggles } from './providers.js'

const execFileP = promisify(execFile)

function firstExisting(candidates) {
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return candidates[candidates.length - 1]
}

export function resolveReplyCommand(provider) {
  const home = process.env.HOME || ''
  if (provider === 'codex') {
    const bin = firstExisting([
      process.env.WATCHKEEPER_CODEX_BIN,
      `${home}/.npm-global/bin/codex`,
      `${home}/.local/bin/codex`,
      'codex',
    ])
    return { cmd: bin, args: ['exec', '-s', 'read-only'], stdinIgnore: true }
  }
  if (provider === 'agy') {
    const bin = firstExisting([
      process.env.WATCHKEEPER_AGY_BIN,
      `${home}/.local/bin/agy`,
      'agy',
    ])
    return { cmd: bin, args: ['-p'], suffix: ['--mode', 'plan', '--print-timeout', '300s'], stdinIgnore: true }
  }
  if (provider === 'custom') {
    const cmd = process.env.WATCHKEEPER_CUSTOM_CMD
    if (!cmd) throw new Error('custom provider is not configured (set WATCHKEEPER_CUSTOM_CMD)')
    return { cmd: '/bin/sh', args: ['-lc', cmd], stdinPrompt: true }
  }
  throw new Error(`unknown reply provider: ${provider}`)
}

/** Currently active provider: first enabled one in ORDER (null when all are off). */
export function activeReplyProvider(config = {}) {
  return activeProviders(loadToggles(config))[0] ?? null
}

/**
 * Run once with stdin closed.
 *
 * execFile keeps a stdin pipe open that never closes; `codex exec` waits on stdin,
 * so the child would hang until the timeout.
 */
function runWithStdinClosed(cmd, argv, { timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }) }
    catch (error) { reject(error); return }
    let stdout = '', stderr = '', settled = false
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value) } }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      finish(reject, new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, Math.max(1000, Number(timeoutMs) || 120_000))
    if (typeof timer.unref === 'function') timer.unref()
    try {
      signal?.addEventListener?.('abort', () => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        finish(reject, new Error('aborted'))
      }, { once: true })
    } catch { /* no signal support */ }
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => finish(reject, error))
    child.on('close', code => {
      if (code === 0) finish(resolve, { stdout, stderr })
      else finish(reject, new Error(`${cmd} exited ${code}: ${String(stderr).slice(0, 300)}`))
    })
  })
}

/** Run once with the prompt written to stdin (custom provider). */
function runWithStdinPrompt(cmd, argv, prompt, { timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } }) }
    catch (error) { reject(error); return }
    let stdout = '', stderr = '', settled = false
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value) } }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      finish(reject, new Error(`${cmd} timed out after ${timeoutMs}ms`))
    }, Math.max(1000, Number(timeoutMs) || 120_000))
    if (typeof timer.unref === 'function') timer.unref()
    try {
      signal?.addEventListener?.('abort', () => {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
        finish(reject, new Error('aborted'))
      }, { once: true })
    } catch { /* no signal support */ }
    try { child.stdin.end(String(prompt ?? '')) } catch { /* ignore */ }
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => finish(reject, error))
    child.on('close', code => {
      if (code === 0) finish(resolve, { stdout, stderr })
      else finish(reject, new Error(`${cmd} exited ${code}: ${String(stderr).slice(0, 300)}`))
    })
  })
}

export function normalizeReplyOutput(provider, stdout) {
  const raw = String(stdout ?? '').trim()
  if (!raw) throw new Error(`${provider} returned an empty reply`)
  return raw
}

export async function generateReply({ provider, prompt, timeoutMs = 120_000, signal } = {}) {
  const chosen = (!provider || provider === 'none') ? activeReplyProvider() : provider
  if (!chosen) throw new Error('no reply provider is enabled')
  const spec = resolveReplyCommand(chosen)
  const argv = [...spec.args, String(prompt ?? ''), ...(spec.suffix ?? [])]
  const { stdout, stderr } = spec.stdinPrompt
    ? await runWithStdinPrompt(spec.cmd, spec.args, prompt, { timeoutMs, signal })
    : spec.stdinIgnore
      ? await runWithStdinClosed(spec.cmd, argv, { timeoutMs, signal })
      : await execFileP(spec.cmd, argv, { timeout: timeoutMs, maxBuffer: 1024 * 1024, signal, env: { ...process.env } })
  return {
    provider: chosen,
    text: normalizeReplyOutput(chosen, stdout),
    stderr: String(stderr ?? ''),
  }
}

/** Call every enabled provider in parallel; failures are isolated per provider. */
export async function generateReplies({ providers = activeProviders(loadToggles()), prompt, timeoutMs = 120_000, signal } = {}) {
  const selected = ORDER.filter(id => providers.includes(id))
  if (!selected.length) return []
  return Promise.all(selected.map(async provider => {
    try {
      return await generateReply({ provider, prompt, timeoutMs, signal })
    } catch (error) {
      return { provider, error: String(error?.message ?? error) }
    }
  }))
}
