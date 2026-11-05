// judge 值守 —— 持久化与并发原语（原子写 + 跨进程文件锁 + 指纹 + 脱敏）
//
// 这一层解决的是**旧版实测踩过的三类事故**：
//   1. 两个 DSH 实例（Desktop / Web）同时写 state.json → 后写者把先写者的会话整段抹掉
//      （2026-10-03 现场：9 条会话开关被覆盖成 1 条）。故所有读改写都必须过 `withFileLock`。
//   2. 写文件写到一半被 kill → 下次读到半个 JSON。故一律「临时文件 + rename」原子落盘。
//   3. 日志无限复制完整对话 → 隐私与体积双爆。故留痕只写摘要 + 指纹（`summarize` / `redact`）。

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { FILES, stateDir } from './paths.js'

/** ISO 时间戳（所有留痕统一用这个格式，跨文件可比对）。 */
export function nowIso(now = Date.now()) {
  return new Date(now).toISOString()
}

export function ensureDir(dir = stateDir()) {
  try { mkdirSync(dir, { recursive: true }) } catch { /* 已存在 */ }
}

/**
 * 读 JSON；文件缺失或损坏一律返回 fallback（**不抛**）。
 *
 * 损坏不抛是刻意的：接管状态读不出来时，正确行为是「不推进」（调用方按关闭处理），
 * 而不是让插件在会话事件里抛错、把宿主日志刷满。
 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** A write transaction must distinguish a missing file from damaged state. */
export function readJsonForUpdate(file, fallback = null) {
  let source
  try { source = readFileSync(file, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
  try {
    const value = JSON.parse(source)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  } catch { /* damaged JSON */ }
  const error = new Error(`watchkeeper: corrupt state file ${file}`)
  error.code = 'state-corrupt'
  throw error
}

/** 原子写 JSON：同目录临时文件 + rename，读方永远看不到半个文件。 */
export function writeJsonAtomic(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 追加一行 JSONL；失败只记日志，不打断接管流程。 */
export function appendJsonl(file, entry, onError) {
  ensureDir(dirname(file))
  try {
    writeFileSync(file, `${JSON.stringify(entry)}\n`, { flag: 'a' })
  } catch (error) {
    try { onError?.(error) } catch { /* 记录失败不得影响会话 */ }
  }
}

/** 进程实例标识：同机多实例（Desktop / Web）必须能互相区分，故默认带 pid。 */
export function instanceId() {
  const label = process.env.WATCHKEEPER_INSTANCE
  if (label) return label
  if (!INSTANCE) INSTANCE = `jev-${process.pid}-${randomUUID().slice(0, 8)}`
  return INSTANCE
}
let INSTANCE = null

const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 3_000

/**
 * 跨进程排他锁（**目录级**）：所有「读—改—写」状态文件的动作都必须包在这里面。
 *
 * 实现用 O_EXCL 创建锁文件：POSIX 下这是原子的，比「先看有没有再创建」可靠。
 * 陈旧锁（持有进程被 kill）按 mtime 超时自动清理，避免永久卡死。
 * 锁内是同步读改写 —— 状态变更很轻，不需要异步化的复杂度（同 ui-control 的既有做法）。
 *
 * @param name 锁文件名（同一目录内唯一）。
 * @param fn 同步读改写函数，返回值原样透出。
 */
export function withFileLock(name, fn, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS, dir = stateDir() } = {}) {
  ensureDir(dir)
  const lockPath = join(dir, `${name}.lock`)
  const deadline = Date.now() + timeoutMs
  let fd = null
  while (fd === null) {
    try {
      fd = openSync(lockPath, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          unlinkSync(lockPath)
          continue
        }
      } catch { /* 锁刚好被释放 */ }
      if (Date.now() > deadline) throw new Error(`watchkeeper: 状态锁超时 ${lockPath}`)
      const until = Date.now() + 15
      while (Date.now() < until) { /* 短暂自旋 */ }
    }
  }
  try {
    return fn()
  } finally {
    try { closeSync(fd) } catch { /* 已关闭 */ }
    try { unlinkSync(lockPath) } catch { /* 已被清理 */ }
  }
}

/** 写锁文件（含内容），给跨进程操作锁用。 */
export function writeLockFile(path, payload) {
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(payload), 'utf8')
}

export function lockFileExists(path) {
  return existsSync(path)
}

/** 稳定指纹：会话 + 决策卡正文 → 短哈希（十六进制，前 16 位足够区分）。 */
export function fingerprintOf(sessionId, cardText) {
  return createHash('sha1')
    .update(`${sessionId}\u0000${String(cardText ?? '')}`)
    .digest('hex')
    .slice(0, 16)
}

/** 文本归一化：只用于比对与指纹，改变内容语义的空白差异不算新卡片。 */
export function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

const SECRET_PATTERNS = [
  /(?:api[_-]?key|token|secret|passwo?rd|authorization)\s*[:=]\s*\S+/gi,
  /\b(?:sk|pk|ghp|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\b[A-Za-z0-9_-]{32,}\b/g,
]

/** 脱敏：日志与留痕里不允许出现凭据、长密钥串。 */
export function redact(text, max = 400) {
  let out = String(text ?? '')
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return summarize(out, max)
}

/** 截断 + 归一化：留痕只记摘要，不无限复制完整对话。 */
export function summarize(text, max = 400) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized
}

/** 文件是否存在（供健康检查/恢复用）。 */
export function fileExists(file) {
  return existsSync(file)
}

export { FILES }
