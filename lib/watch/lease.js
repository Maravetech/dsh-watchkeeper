// judge 值守 —— 接管租约（有期限、有轮数、有预算的接管记录）
//
// 旧版把接管写成 `sessionId → true / false` 的永久布尔值，长期运行会出三类问题：
//   · 无法回答「还能跑多久」——到期行为不存在，开关就是一个不会失效的授权；
//   · 无法回答「跑了多少」——没有轮数与 token 记账，长会话的主模型消耗无从察觉；
//   · 历史遗留的 true 会被周期扫描永久拾起，the operator 早就不关心的旧任务继续被推进。
//
// 租约把这些补上：开始时间、最后活动、到期时间、最大轮数、已完成轮数、
// token 预算与已用量、当前相位、停止原因。**到期的租约不再产生任何新判断或新发送。**

import { FILES } from './paths.js'
import { nowIso, readJson, readJsonForUpdate, summarize, withFileLock, writeJsonAtomic } from './store.js'

/** 状态文件版本：v1 = 旧的 { sessions: {id: bool} }；v2 = 租约 + 迁移信息。 */
export const STATE_VERSION = 2

/** 自动回复清单长度：界面半据此给气泡画橙色 chip（重启后历史标记不丢）。 */
export const AUTO_REPLY_KEEP = 100

/** 租约默认值（profile 可覆盖；未校准前只作默认，不叫「已校准阈值」）。 */
export const LEASE_DEFAULTS = {
  /** CODEX: Kept only for state-file compatibility; rounds never stop progress. */
  maxRounds: null,
  /** token 预算（judge 判断 + DSH 主回合合计）：默认 $3 USD（按 DeepSeek 缓存读折算约 2 亿 token）。 */
  tokenBudget: 200_000_000,
  /** 租约有效期（毫秒）：默认 24 小时，到期即停，需 the operator 重新开启或续期。 */
  ttlMs: 24 * 60 * 60 * 1000,
  /** 停止后保留记录、允许重新开启。 */
  owner: 'watchkeeper',
}

function emptyStore() {
  return { version: STATE_VERSION, updatedAt: nowIso(), leases: {}, legacy: {}, autoReplies: [] }
}

function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object') return emptyStore()
  const store = {
    version: STATE_VERSION,
    updatedAt: raw.updatedAt ?? nowIso(),
    leases: raw.leases && typeof raw.leases === 'object' ? { ...raw.leases } : {},
    legacy: raw.legacy && typeof raw.legacy === 'object' ? { ...raw.legacy } : {},
    autoReplies: Array.isArray(raw.autoReplies) ? raw.autoReplies.slice(-AUTO_REPLY_KEEP) : [],
  }
  // 自动修复：检测并纠正历史受旧 bug 污染而膨胀到数千万甚至十亿的 dshTokens（仅限旧 500k 预算记录）
  for (const lease of Object.values(store.leases)) {
    if (
      lease
      && typeof lease === 'object'
      && (lease.tokenBudget ?? 0) <= 500_000
      && ((lease.dshTokens ?? 0) > 50_000_000 || (lease.tokenUsed ?? 0) > 50_000_000)
    ) {
      lease.tokenUsed = lease.jevTokens ?? 0
      lease.dshTokens = 0
      lease.cacheReadTokens = 0
      lease.usageCursor = null
      if (lease.phase === 'budget-exhausted') {
        lease.phase = lease.enabled ? 'taking-over' : 'off'
        lease.reason = lease.enabled ? 'recovered-baseline' : 'disabled'
        lease.stopReason = null
      }
    }
  }
  return store
}

/**
 * 旧格式迁移：`{ sessions: { id: true } }` → 过期记录 + 证据。
 *
 * 迁移原则（the operator 定）：**不直接删除历史证据**，把旧 `true` 迁成「已过期的旧格式记录」，
 * 保留原开启信息，需要重新开启才获得新租约。故旧记录进 `legacy`，租约写成禁用态。
 */
export function migrateLegacy(raw, now = Date.now()) {
  const store = normalizeStore(raw)
  // 旧文件里可能已经带有 v2 段（过渡期由测试/脚本写过）：先整体继承，再补会话开关。
  const sessions = raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : null
  if (!sessions) return { store, migrated: [] }
  const migrated = []
  for (const [sessionId, enabled] of Object.entries(sessions)) {
    if (store.legacy[sessionId]) continue
    const at = nowIso(now)
    store.legacy[sessionId] = {
      originalEnabled: enabled === true,
      migratedAt: at,
      note: enabled === true
        ? '旧格式开关（无租约），已迁移为过期记录；需重新开启才会获得新租约'
        : '旧格式关闭记录，保留为证据',
    }
    if (enabled === true && !store.leases[sessionId]) {
      store.leases[sessionId] = {
        leaseId: null,
        sessionId,
        enabled: false,
        owner: LEASE_DEFAULTS.owner,
        instanceId: null,
        enabledAt: null,
        lastActivityAt: at,
        expiresAt: at,
        maxRounds: LEASE_DEFAULTS.maxRounds,
        // CODEX: no round window exists; keep the cumulative visible counter on renewal.
        completedRounds: 0,
        totalRounds: 0,
        tokenBudget: LEASE_DEFAULTS.tokenBudget,
        tokenUsed: 0,
        jevTokens: 0,
        dshTokens: 0,
        cacheReadTokens: 0,
        tokensUnavailable: false,
        usageCursor: null,
        phase: 'lease-expired',
        reason: 'legacy-no-lease',
        stopReason: 'legacy-migrated',
        updatedAt: at,
        history: [],
      }
    }
    migrated.push(sessionId)
  }
  return { store, migrated }
}

/**
 * 读状态文件（**只读**，不落盘）：旧格式在内存里完成迁移。
 *
 * 两处来源，各有明确职责：
 *   · `leases.json` —— v2 唯一权威（租约 / 迁移信息 / 自动回复清单）；
 *   · `state.json`  —— 旧版文件，只读：① 首次迁移时把 v2 段整体搬过来；
 *                      ② 之后仍读它的 `sessions` 开关，把旧版新开的会话标成「历史开关」。
 */
export function readStore() {
  const current = readJson(FILES.leases, null)
  if (current) {
    const store = normalizeStore(current)
    applyLegacySwitches(store, readJson(FILES.legacyState, null))
    return store
  }
  const { store } = migrateLegacy(readJson(FILES.legacyState, null))
  return store
}

/** 把旧文件里的会话开关补成「历史开关」记录（幂等；不覆盖已有租约）。 */
function applyLegacySwitches(store, legacyRaw, now = Date.now()) {
  const sessions = legacyRaw?.sessions && typeof legacyRaw.sessions === 'object' ? legacyRaw.sessions : null
  if (!sessions) return store
  for (const [sessionId, enabled] of Object.entries(sessions)) {
    if (store.legacy[sessionId]) continue
    const at = nowIso(now)
    store.legacy[sessionId] = {
      originalEnabled: enabled === true,
      migratedAt: at,
      note: enabled === true
        ? '旧格式开关（无租约），已迁移为过期记录；需重新开启才会获得新租约'
        : '旧格式关闭记录，保留为证据',
    }
    if (enabled === true && !store.leases[sessionId]) {
      store.leases[sessionId] = { ...emptyLease(sessionId, now), phase: 'lease-expired', reason: 'legacy-no-lease', stopReason: 'legacy-migrated' }
    }
  }
  return store
}

/**
 * 读—改—写（**跨进程加锁**）。所有会改状态的动作都必须走这里：
 * 两个 DSH 实例同时开 judge 时，后写者不能覆盖先写者的会话（旧版实测被覆盖过）。
 */
export function withStore(fn, { now = Date.now() } = {}) {
  return withFileLock('leases', () => {
    const current = readJsonForUpdate(FILES.leases, null)
    if (current && (current.version !== STATE_VERSION || !current.leases || typeof current.leases !== 'object' || Array.isArray(current.leases))) {
      throw new Error(`watchkeeper: corrupt state file ${FILES.leases}`)
    }
    const { store, migrated } = current
      ? { store: normalizeStore(current), migrated: [] }
      : migrateLegacy(readJson(FILES.legacyState, null), now)
    applyLegacySwitches(store, readJson(FILES.legacyState, null), now)
    const out = fn(store, { migrated, now })
    store.updatedAt = nowIso(now)
    writeJsonAtomic(FILES.leases, store)
    return out === undefined ? store : out
  })
}

/** 首次落地：把旧格式迁移结果写盘（幂等）。 */
export function persistMigration(now = Date.now()) {
  return withStore((store) => store, { now })
}

export function getLease(sessionId) {
  return readStore().leases[String(sessionId ?? '')] ?? null
}

export function listLeases() {
  return readStore().leases
}

export function listLegacy() {
  return readStore().legacy
}

/**
 * 开启接管：**生成新租约**（或对已有租约续期）。
 *
 * 续期语义（the operator 定：达到上限后「the operator 手动续期后才能继续」）：
 *   · 轮数窗口归零（grantedRounds++），累计轮数 totalRounds 不重置；
 *   · 预算**追加一档**（tokenBudget += 默认预算），累计已用不重置 —— 不许用重置掩盖成本；
 *   · 到期时间从当前时刻重算；
 *   · **操作记录（ops）不动**：已提交/判断中的卡片不会因为续期被重发。
 */
export function enableLease(sessionId, options = {}) {
  const key = String(sessionId ?? '')
  if (!key) throw new Error('enableLease: sessionId required')
  const now = options.now ?? Date.now()
  const d = { ...LEASE_DEFAULTS, ...options }
  return withStore((store) => {
    const existing = store.leases[key]
    const at = nowIso(now)
    if (existing && existing.enabled === true && existing.leaseId) {
      const renewed = {
        ...existing,
        enabled: true,
        instanceId: d.instanceId ?? existing.instanceId,
        lastActivityAt: at,
        expiresAt: nowIso(now + d.ttlMs),
        maxRounds: d.maxRounds,
        replyProvider: d.replyProvider ?? existing.replyProvider ?? null,
        openclawEnabled: d.openclawEnabled === true ? true : (existing.openclawEnabled === true),
        fallbackEnabled: d.fallbackEnabled === true ? true : (existing.fallbackEnabled === true),
        hermesFallback: d.hermesFallback === true ? true : (existing.hermesFallback === true),
        // 任务授权字段随租约续期保留：任务结算前一直有效（the operator 2026-10-07）。
        ...(d.authorizedBy === 'task' ? { authorizedBy: 'task', taskId: d.taskId ?? existing.taskId ?? null } : {}),
        completedRounds: 0,
        tokenBudget: (Number(existing.tokenBudget) || 0) + d.tokenBudget,
        phase: 'taking-over',
        reason: 'renewed',
        stopReason: null,
        renewCount: (existing.renewCount ?? 0) + 1,
        updatedAt: at,
        history: pushHistory(existing.history, { at, event: 'renewed', note: `expiresAt=${nowIso(now + d.ttlMs)}` }),
      }
      store.leases[key] = renewed
      return renewed
    }
    const lease = {
      leaseId: `${key}-${now.toString(36)}`,
      sessionId: key,
      enabled: true,
      owner: d.owner,
      instanceId: d.instanceId ?? null,
      enabledAt: at,
      lastActivityAt: at,
      expiresAt: nowIso(now + d.ttlMs),
      maxRounds: d.maxRounds,
      replyProvider: d.replyProvider ?? existing?.replyProvider ?? null,
      openclawEnabled: d.openclawEnabled === true ? true : (existing?.openclawEnabled === true),
      fallbackEnabled: d.fallbackEnabled === true ? true : (existing?.fallbackEnabled === true),
      hermesFallback: d.hermesFallback === true ? true : (existing?.hermesFallback === true),
      // 任务授权来源与任务号：只有 the operator 明确授权的项目任务才写（普通开启不带）。
      ...(d.authorizedBy === 'task' ? { authorizedBy: 'task', taskId: d.taskId ?? null } : {}),
      completedRounds: 0,
      totalRounds: 0,
      tokenBudget: d.tokenBudget,
      tokenUsed: 0,
      jevTokens: 0,
      dshTokens: 0,
      cacheReadTokens: 0,
      tokensUnavailable: false,
      usageCursor: null,
      phase: 'taking-over',
      reason: 'toggle-on',
      stopReason: null,
      renewCount: 0,
      lastSubmission: null,
      lastReceipt: null,
      updatedAt: at,
      history: pushHistory(existing?.history, { at, event: 'enabled', legacy: store.legacy[key]?.originalEnabled === true }),
    }
    store.leases[key] = lease
    return lease
  }, { now })
}

/** 关闭接管：保留记录（含累计用量与轮数），相位落到 off。 */
export function disableLease(sessionId, reason = 'toggle-off') {
  const key = String(sessionId ?? '')
  const now = Date.now()
  return withStore((store) => {
    const existing = store.leases[key]
    const at = nowIso(now)
    if (!existing) {
      store.leases[key] = {
        ...emptyLease(key, now),
        enabled: false,
        phase: 'off',
        reason,
        stopReason: reason,
      }
      return store.leases[key]
    }
    store.leases[key] = {
      ...existing,
      enabled: false,
      phase: 'off',
      reason,
      stopReason: reason,
      lastActivityAt: at,
      updatedAt: at,
      history: pushHistory(existing.history, { at, event: 'disabled', note: reason }),
    }
    return store.leases[key]
  }, { now })
}

function emptyLease(sessionId, now) {
  return {
    leaseId: null,
    sessionId,
    enabled: false,
    owner: LEASE_DEFAULTS.owner,
    instanceId: null,
    enabledAt: null,
    lastActivityAt: nowIso(now),
    expiresAt: nowIso(now),
    maxRounds: LEASE_DEFAULTS.maxRounds,
    completedRounds: 0,
    totalRounds: 0,
    tokenBudget: LEASE_DEFAULTS.tokenBudget,
    tokenUsed: 0,
    jevTokens: 0,
    dshTokens: 0,
    cacheReadTokens: 0,
    tokensUnavailable: false,
    usageCursor: null,
    phase: 'off',
    reason: 'disabled',
    stopReason: null,
    updatedAt: nowIso(now),
    history: [],
  }
}

function pushHistory(history, entry, cap = 50) {
  const list = Array.isArray(history) ? [...history, entry] : [entry]
  return list.slice(-cap)
}

/** 局部更新租约（不清空未给出的字段）。 */
export function patchLease(sessionId, patch, { now = Date.now(), history = null } = {}) {
  const key = String(sessionId ?? '')
  return withStore((store) => {
    const existing = store.leases[key] ?? emptyLease(key, now)
    const at = nowIso(now)
    const next = {
      ...existing,
      ...patch,
      updatedAt: at,
    }
    if (patch?.touchActivity !== false) next.lastActivityAt = at
    if (history) next.history = pushHistory(existing.history, { at, ...history })
    store.leases[key] = next
    return next
  }, { now })
}

/**
 * 租约准入判定：这是「到期就停」的**唯一实现**，所有入口（扫描 / 事件 / 手动）
 * 都必须先过它，不允许各写一遍「看看 enabled」。
 *
 * @returns `{ allowed, phase, reason }`：allowed=false 时调用方直接停手，不判断、不发送。
 */
export function leaseVerdict(lease, now = Date.now()) {
  if (!lease) return { allowed: false, phase: 'off', reason: 'disabled' }
  if (lease.enabled !== true) return { allowed: false, phase: 'off', reason: lease.reason ?? 'disabled' }
  if (lease.phase === 'session-complete') {
    return { allowed: false, phase: 'session-complete', reason: lease.reason ?? 'completion-evidence-confirmed' }
  }
  const expiresAtMs = lease.expiresAt ? Date.parse(lease.expiresAt) : null
  if (expiresAtMs !== null && expiresAtMs <= now) {
    return { allowed: false, phase: 'lease-expired', reason: 'lease-expired' }
  }
  // CODEX: completedRounds is telemetry only; task completion, not a counter, is the normal stop.
  const budget = Number.isFinite(lease.tokenBudget) ? lease.tokenBudget : null
  const used = Number.isFinite(lease.tokenUsed) ? lease.tokenUsed : 0
  if (budget !== null && used >= budget) {
    return { allowed: false, phase: 'budget-exhausted', reason: 'budget-exhausted' }
  }
  return { allowed: true, phase: lease.phase ?? 'observing', reason: null }
}

/** judge 判断成本入账（判断一发就记账，无论最终是否发送）。 */
export function accountJudgeUsage(sessionId, usage, { now = Date.now() } = {}) {
  const tokens = Number(usage?.totalTokens ?? ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0))) || 0
  if (!tokens) return null
  return withStore((store) => {
    const key = String(sessionId ?? '')
    const lease = store.leases[key] ?? emptyLease(key, now)
    const next = {
      ...lease,
      jevTokens: (lease.jevTokens ?? 0) + tokens,
      tokenUsed: (lease.tokenUsed ?? 0) + tokens,
      // 记住最近一次判断的真实成本：下一次判断前用它在预算上「预留」，
      // 避免出现「判断花了钱、发送却被预算拦下」的白花。
      lastjudgeTokens: tokens,
      updatedAt: nowIso(now),
    }
    store.leases[key] = next
    return next
  }, { now })
}

/**
 * DSH 主回合成本入账。
 *
 * 为什么必须与 judge 成本分开记：judge 一次判断只有几百 token，而它触发的新一轮主模型
 * 可能吃掉几十万上下文 token。**用小额 judge 数据掩盖大额 DSH 消耗**是这一层最危险的
 * 失真形式，故两者分列，预算按合计判定。
 *
 * 取不到 usage 时写 `tokensUnavailable`（界面显示「无法取数」），**不猜数**。
 */
export function accountDshUsage(sessionId, folded, { now = Date.now() } = {}) {
  if (!folded || folded.steps === 0) {
    return patchLease(sessionId, { tokensUnavailable: true }, { now, touchActivity: false })
  }
  return withStore((store) => {
    const key = String(sessionId ?? '')
    const lease = store.leases[key] ?? emptyLease(key, now)
    const prev = lease.usageCursor
    let delta
    if (prev) {
      delta = {
        uncachedInput: Math.max(0, folded.uncachedInput - (prev.uncachedInput ?? 0)),
        output: Math.max(0, folded.output - (prev.output ?? 0)),
        cacheRead: Math.max(0, folded.cacheRead - (prev.cacheRead ?? 0)),
        cacheWrite: Math.max(0, folded.cacheWrite - (prev.cacheWrite ?? 0)),
      }
    } else {
      // 首次观察（prev 为 null）：
      // 若会话只有 1 步（新会话或测试桩），计入该步消耗；
      // 若已有历史长跑（steps > 1），只计入生成当前卡片的最后一步（lastStepUsage），
      // 绝不能将之前成百上千轮的历史累计总额当成本次接管的新增量。
      const firstUsage = folded.lastStepUsage ?? (folded.steps <= 1 ? folded : null)
      if (firstUsage) {
        delta = {
          uncachedInput: firstUsage.uncachedInput ?? 0,
          output: firstUsage.output ?? 0,
          cacheRead: firstUsage.cacheRead ?? 0,
          cacheWrite: firstUsage.cacheWrite ?? 0,
        }
      } else {
        delta = { uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    }
    const total = delta.uncachedInput + delta.output + delta.cacheRead + delta.cacheWrite
    const at = nowIso(now)
    store.leases[key] = {
      ...lease,
      tokenUsed: (lease.tokenUsed ?? 0) + total,
      dshTokens: (lease.dshTokens ?? 0) + total,
      cacheReadTokens: (lease.cacheReadTokens ?? 0) + delta.cacheRead,
      tokensUnavailable: false,
      usageCursor: { ...folded },
      updatedAt: at,
      usageObservedAt: at,
    }
    return { delta, total, lease: store.leases[key] }
  }, { now })
}

/**
 * 判断前的预算预留闸门：连**下一次判断**都付不起时就不要再调 judge。
 *
 * 已知成本 `lastjudgeTokens` 才预留（首轮没有历史值，不拦 —— 否则小额预算会一次都跑不了）。
 * 边界用 `>=`：恰好花完预算也算耗尽，避免「判断花掉最后一分钱、发送被拦」的白跑。
 */
export function budgetGuardForJudge(lease) {
  const budget = Number.isFinite(lease?.tokenBudget) ? lease.tokenBudget : null
  const used = Number.isFinite(lease?.tokenUsed) ? lease.tokenUsed : 0
  const reserve = Number.isFinite(lease?.lastjudgeTokens) && lease.lastjudgeTokens > 0 ? lease.lastjudgeTokens : 0
  if (budget !== null && used + reserve >= budget) {
    return { allowed: false, reason: 'budget-exhausted' }
  }
  return { allowed: true }
}

/** 完成一次回复：计数只留痕，写最近一次提交与回执，不参与停止。 */
export function accountRound(sessionId, { submission, receipt, now = Date.now() } = {}) {
  return withStore((store) => {
    const key = String(sessionId ?? '')
    const lease = store.leases[key] ?? emptyLease(key, now)
    const completed = (lease.completedRounds ?? 0) + 1
    const at = nowIso(now)
    const next = {
      ...lease,
      completedRounds: completed,
      totalRounds: (lease.totalRounds ?? 0) + 1,
      lastActivityAt: at,
      updatedAt: at,
      lastSubmission: submission ?? lease.lastSubmission ?? null,
      lastReceipt: receipt ?? lease.lastReceipt ?? null,
      phase: 'sent',
      reason: 'sent',
      stopReason: null,
      history: pushHistory(lease.history, {
        at,
        event: 'round-committed',
        round: completed,
        picked: summarize(submission?.text ?? '', 120),
      }),
    }
    store.leases[key] = next
    return next
  }, { now })
}

// ---------------------------------------------------------------- 自动回复清单

/**
 * 记下一条自动回复正文（界面半据此画橙色 chip）。
 *
 * **必须与租约共用同一把状态锁**：早期版本用独立锁写同一个 state.json，
 * 结果两边互相覆盖 —— 租约写丢失 leases，自动回复写丢失租约（实测：
 * 并发场景下 9 条接管记录被覆盖成 1 条）。合并到 `withStore` 后只有一个写者。
 */
export function rememberAutoReply(sessionId, text, { now = Date.now(), provider = null } = {}) {
  const session = String(sessionId ?? '')
  const body = String(text ?? '').trim()
  if (!session || !body) return []
  return withStore((store) => {
    const list = Array.isArray(store.autoReplies) ? store.autoReplies : []
    const kept = list.filter((entry) => !(entry?.sessionId === session && entry?.text === body))
    kept.push({ sessionId: session, text: body, provider, at: nowIso(now) })
    store.autoReplies = kept.slice(-AUTO_REPLY_KEEP)
    return store.autoReplies
  }, { now })
}

/** 读自动回复清单（状态接口与界面半用）。 */
export function readAutoReplies() {
  return readStore().autoReplies ?? []
}
