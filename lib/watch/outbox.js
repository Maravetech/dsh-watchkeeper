// judge 值守 —— 决策卡事务记录 + 跨进程操作锁
//
// 两件必须一起做的事：
//
// 1) **事务状态机**：发现卡片 → judging → decided → sending → committed。
//    旧版的致命缺陷是「发送前就写完成指纹」：发送随后失败时，下一次扫描认为这张卡
//    已处理过，于是永远不再重试，会话永久停在原卡片上（界面看不到代答、开关还开着）。
//    现在只有**拿到 DSH 明确成功回执**才写 committed；失败落 `retryable-failed` 并按退避重试。
//
// 2) **跨进程操作锁**：Desktop 与 Web 是两个独立进程，进程内锁拦不住「两端同时判断、
//    同时发送」。锁键是 `sessionId + decisionFingerprint`，O_EXCL 原子获取、带 TTL、
//    只有持锁者能发送，发送成功后写统一完成记录，另一端看到完成记录直接进入值守。

import { join } from 'node:path'
import { closeSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { FILES, stateDir } from './paths.js'
import {
  ensureDir, lockFileExists, nowIso, readJson, readJsonForUpdate, summarize, withFileLock, writeJsonAtomic, writeLockFile,
} from './store.js'

const OPS_VERSION = 1
const OPS_PER_SESSION_CAP = 10
const LOCK_DEFAULT_TTL_MS = 120_000

function emptyOps() {
  return { version: OPS_VERSION, updatedAt: nowIso(), sessions: {} }
}

function normalizeOps(raw) {
  if (!raw || typeof raw !== 'object' || !raw.sessions || typeof raw.sessions !== 'object') return emptyOps()
  return {
    version: OPS_VERSION,
    updatedAt: raw.updatedAt ?? nowIso(),
    sessions: { ...raw.sessions },
  }
}

export function readOps() {
  return normalizeOps(readJson(FILES.ops, null))
}

/** 读—改—写操作记录（跨进程加锁，两端不会互相覆盖）。 */
export function withOps(fn, { now = Date.now() } = {}) {
  return withFileLock('ops', () => {
    const current = readJsonForUpdate(FILES.ops, null)
    if (current && (current.version !== OPS_VERSION || !current.sessions || typeof current.sessions !== 'object' || Array.isArray(current.sessions))) {
      throw new Error(`watchkeeper: corrupt state file ${FILES.ops}`)
    }
    const ops = normalizeOps(current)
    const out = fn(ops, { now })
    ops.updatedAt = nowIso(now)
    writeJsonAtomic(FILES.ops, ops)
    return out
  })
}

/** 取某会话某张卡片的记录（无则 null）。 */
export function findOp(sessionId, fingerprint) {
  const ops = readOps()
  return ops.sessions[String(sessionId ?? '')]?.[String(fingerprint ?? '')] ?? null
}

/** 取某会话最近一条记录（用于「卡片变了」判定）。 */
export function latestOp(sessionId) {
  const ops = readOps()
  const bucket = ops.sessions[String(sessionId ?? '')] ?? {}
  let newest = null
  for (const record of Object.values(bucket)) {
    const at = Date.parse(record?.updatedAt ?? 0)
    if (!newest || at > Date.parse(newest.updatedAt ?? 0)) newest = record
  }
  return newest
}

/** 写入/更新一条操作记录；返回新记录。 */
export function upsertOp(record, { now = Date.now() } = {}) {
  if (!record?.sessionId || !record?.fingerprint) throw new Error('upsertOp: sessionId + fingerprint required')
  return withOps((ops) => {
    const key = String(record.sessionId)
    const bucket = ops.sessions[key] ?? {}
    const existing = bucket[record.fingerprint] ?? null
    const at = nowIso(now)
    const next = {
      ...existing,
      ...record,
      createdAt: existing?.createdAt ?? record.createdAt ?? at,
      updatedAt: at,
    }
    bucket[record.fingerprint] = next
    // 只保留最近 N 张卡片：留痕在 decisions.jsonl 里是全量的，这里只做状态去重。
    const entries = Object.entries(bucket)
      .sort((a, b) => Date.parse(a[1]?.updatedAt ?? 0) - Date.parse(b[1]?.updatedAt ?? 0))
      .slice(-OPS_PER_SESSION_CAP)
    ops.sessions[key] = Object.fromEntries(entries)
    return next
  }, { now })
}

/** 标记某张卡片为「已被更新版本取代」：不删记录，留证据。 */
export function markStale(sessionId, fingerprint, { now = Date.now() } = {}) {
  return withOps((ops) => {
    const bucket = ops.sessions[String(sessionId ?? '')]
    const record = bucket?.[String(fingerprint ?? '')]
    if (!record) return null
    bucket[fingerprint] = { ...record, phase: 'stale', staleAt: nowIso(now), updatedAt: nowIso(now) }
    return bucket[fingerprint]
  }, { now })
}

/** 清理：删除超过保留期的终态记录（默认 7 天）。 */
export function pruneOps({ now = Date.now(), keepMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  return withOps((ops) => {
    let removed = 0
    for (const [sessionId, bucket] of Object.entries(ops.sessions)) {
      for (const [fp, record] of Object.entries(bucket)) {
        const terminal = ['committed', 'failed', 'needs-human', 'human-answered', 'stale'].includes(record?.phase)
        if (terminal && now - Date.parse(record?.updatedAt ?? 0) > keepMs) {
          delete bucket[fp]
          removed += 1
        }
      }
      if (Object.keys(bucket).length === 0) delete ops.sessions[sessionId]
    }
    return { removed }
  }, { now })
}

/** 该卡片是否已提交（跨进程可见）。 */
export function isCommitted(sessionId, fingerprint) {
  return findOp(sessionId, fingerprint)?.phase === 'committed'
}

/**
 * 重试退避：5s → 10s → 20s → 40s → 80s → 160s → 300s 封顶。
 *
 * 为什么要有退避而不是「每个扫描周期都重试」：发送失败常见原因是会话正忙 /
 * 生命周期已释放，立刻重试只会连续撞同一堵墙；退避让恢复后自动重试仍然发生
 * （验收要求：恢复发送通道后自动重试），但不会变成高频重试风暴。
 */
export function backoffMs(attempt, { base = 5_000, max = 300_000 } = {}) {
  const n = Math.max(1, Number(attempt) || 1)
  return Math.min(max, base * 2 ** (n - 1))
}

// ---------------------------------------------------------------- 跨进程操作锁

const SAFE = /[^A-Za-z0-9._-]/g

/** 锁文件名：会话 id + 卡片指纹（同一个决策卡只有一把锁）。 */
export function lockKey(sessionId, fingerprint) {
  return `${String(sessionId ?? '').replace(SAFE, '_')}__${String(fingerprint ?? '').replace(SAFE, '_')}`
}

export function lockPath(sessionId, fingerprint) {
  return join(FILES.locks, `${lockKey(sessionId, fingerprint)}.lock`)
}

function withDecisionLock(sessionId, fingerprint, fn) {
  return withFileLock(`decision-${lockKey(sessionId, fingerprint)}`, fn, { dir: stateDir() })
}

export function readDecisionLock(sessionId, fingerprint) {
  const path = lockPath(sessionId, fingerprint)
  if (!lockFileExists(path)) return null
  return readJson(path, null)
}

/**
 * 原子获取决策锁。
 *
 * `O_EXCL` 创建是 POSIX 下原子的：两端同时抢，只有一个成功。
 * 已存在的锁若 `expiresAt` 已过（持有者崩溃 / 被 kill），允许**抢占**：
 * 先 unlink 再重新 O_EXCL 创建；两端同时抢占时仍只有一个能建成。
 */
export function acquireDecisionLock({
  sessionId, fingerprint, instanceId, ttlMs = LOCK_DEFAULT_TTL_MS, now = Date.now(), phase = 'judging',
}) {
  return withDecisionLock(sessionId, fingerprint, () => acquireDecisionLockUnlocked({ sessionId, fingerprint, instanceId, ttlMs, now, phase }))
}

function acquireDecisionLockUnlocked({ sessionId, fingerprint, instanceId, ttlMs, now, phase }) {
  const path = lockPath(sessionId, fingerprint)
  ensureDir(FILES.locks)
  const payload = {
    sessionId: String(sessionId),
    fingerprint: String(fingerprint),
    instanceId,
    acquiredAt: nowIso(now),
    expiresAt: nowIso(now + ttlMs),
    phase,
    updatedAt: nowIso(now),
  }
  try {
    writeLockFileExclusive(path, payload)
    return { ok: true, lock: payload, path }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const existing = readJson(path, null)
  const expiresAt = existing?.expiresAt ? Date.parse(existing.expiresAt) : 0
  if (expiresAt && expiresAt > now) {
    return { ok: false, holder: existing?.instanceId ?? 'unknown', lock: existing, path }
  }
  // 过期锁：抢占（先删再建；竞争失败的一方会看到新锁并放弃）。
  try { unlinkSync(path) } catch { /* 已被别人抢先清理 */ }
  try {
    writeLockFileExclusive(path, payload)
    return { ok: true, lock: payload, path, stoleFrom: existing?.instanceId ?? null }
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return { ok: false, holder: readJson(path, null)?.instanceId ?? 'unknown', lock: readJson(path, null), path }
    }
    throw error
  }
}

function writeLockFileExclusive(path, payload) {
  // 用 'wx' 旗标：文件已存在即抛 EEXIST，不做「先查后建」。
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(payload), 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** 续租（持锁者活着就不断延长；崩溃后自然过期，另一端可接管）。 */
export function touchDecisionLock(sessionId, fingerprint, { instanceId, ttlMs = LOCK_DEFAULT_TTL_MS, now = Date.now(), phase } = {}) {
  return withDecisionLock(sessionId, fingerprint, () => touchDecisionLockUnlocked(sessionId, fingerprint, { instanceId, ttlMs, now, phase }))
}

function touchDecisionLockUnlocked(sessionId, fingerprint, { instanceId, ttlMs, now, phase }) {
  const path = lockPath(sessionId, fingerprint)
  const existing = readJson(path, null)
  if (!existing) return null
  if (instanceId && existing.instanceId !== instanceId) return existing
  const next = {
    ...existing,
    expiresAt: nowIso(now + ttlMs),
    updatedAt: nowIso(now),
    ...(phase ? { phase } : {}),
  }
  writeJsonAtomic(path, next)
  return next
}

/** 释放锁（只允许持有者释放；运维可用 force）。 */
export function releaseDecisionLock(sessionId, fingerprint, { instanceId, force = false } = {}) {
  return withDecisionLock(sessionId, fingerprint, () => releaseDecisionLockUnlocked(sessionId, fingerprint, { instanceId, force }))
}

function releaseDecisionLockUnlocked(sessionId, fingerprint, { instanceId, force }) {
  const path = lockPath(sessionId, fingerprint)
  if (!lockFileExists(path)) return { released: false, reason: 'missing' }
  const existing = readJson(path, null)
  if (!force && instanceId && existing?.instanceId && existing.instanceId !== instanceId) {
    return { released: false, reason: 'not-holder', holder: existing.instanceId }
  }
  try { unlinkSync(path) } catch { /* 已释放 */ }
  return { released: true }
}

/** 列出当前所有锁（用于状态接口与「谁在发」排查）。 */
export function listDecisionLocks({ now = Date.now() } = {}) {
  ensureDir(FILES.locks)
  const out = []
  try {
    for (const entry of readdirSync(FILES.locks)) {
      if (!entry.endsWith('.lock')) continue
      const record = readJson(join(FILES.locks, entry), null)
      if (!record) continue
      const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : 0
      out.push({ ...record, file: entry, expired: expiresAt <= now })
    }
  } catch { /* 目录不可读时返回空 */ }
  return out
}

/**
 * 会话 token 用量折算（DSH 真实用量读回）。
 *
 * 事件里的 `assistant/message.data.usage` 是 provider 报的原始口径：
 * 未缓存输入 / 输出 / 缓存读 / 缓存写**分列**，不合并 —— 缓存读便宜但不是零，
 * 混在一起会让「预算还剩多少」失真（the operator 明确要求分开记录）。
 *
 * @param events 会话事件序列（`sessionController.inspect()` 的 events 或内存快照）。
 */
export function foldSessionUsage(events) {
  const list = Array.isArray(events) ? events : []
  const totals = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, steps: 0, lastAt: null }
  let lastStepUsage = null
  for (const event of list) {
    if (event?.type !== 'assistant/message') continue
    const usage = event?.data?.usage
    if (!usage || typeof usage !== 'object') continue
    const uncachedInput = number(usage.inputTokens)
    const output = number(usage.outputTokens)
    const cacheRead = number(usage.cacheReadTokens)
    const cacheWrite = number(usage.cacheWriteTokens)
    totals.uncachedInput += uncachedInput
    totals.output += output
    totals.cacheRead += cacheRead
    totals.cacheWrite += cacheWrite
    totals.steps += 1
    if (typeof event.time === 'number') totals.lastAt = event.time
    lastStepUsage = { uncachedInput, output, cacheRead, cacheWrite, total: uncachedInput + output + cacheRead + cacheWrite }
  }
  return { ...totals, total: totals.uncachedInput + totals.output + totals.cacheRead + totals.cacheWrite, lastStepUsage }
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 从会话事件里找「带 judge 标记的用户消息」——崩溃恢复的读回依据。 */
export function findMarkedUserMessages(events, prefix) {
  const list = Array.isArray(events) ? events : []
  const prefixes = Array.isArray(prefix) ? prefix : [prefix, '【judge', '【GEV']
  const out = []
  for (const event of list) {
    if (event?.type !== 'user/message') continue
    const blocks = event?.data?.message?.content
    const text = Array.isArray(blocks)
      ? blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
      : ''
    if (prefixes.some((p) => p && text.startsWith(p))) out.push({ text, at: event.time ?? null })
  }
  return out
}

/** 留痕摘要（判定/提交都走这个，避免把整段会话复制进日志）。 */
export function evidenceSummary(record) {
  return {
    sessionId: record.sessionId,
    checkpointId: record.checkpointId ?? null,
    decisionFingerprint: record.fingerprint,
    triggerSource: record.triggerSource ?? null,
    question: summarize(record.question ?? '', 200),
    contextChars: record.contextChars ?? 0,
    options: Array.isArray(record.options) ? record.options.map((o) => summarize(o, 120)) : [],
    forwardProbability: record.forwardProbability ?? null,
    picked: record.picked ?? null,
    reason: record.reason ?? null,
  }
}
