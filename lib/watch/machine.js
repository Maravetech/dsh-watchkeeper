// judge 值守 —— 统一状态机（相位 / 中文显示名 / 停止原因 / 状态摘要）
//
// 旧版只有「开 / 关」两态加几个临时字符串，结果是界面只能显示「待人工」，
// 却答不出**为什么**待人工。这里把状态机做成唯一真源：
// 宿主半写、渲染半显示、HTTP 接口回报、回归测试断言，全部引用同一份定义。

/**
 * 相位定义：`zh` 是界面中文名，`terminal` 表示「不自动前进、等外部动作」，
 * `group` 只用于界面归类（正常推进 / 暂停 / 终止）。
 */
export const PHASES = {
  off: { zh: '关', group: 'idle', terminal: true },
  'taking-over': { zh: '接管中', group: 'running' },
  // CODEX: The enabled idle state uses the operator's exact compact label: "值守".
  observing: { zh: '值守', group: 'running' },
  checking: { zh: '检查中', group: 'running' },
  judging: { zh: '判断中', group: 'running' },
  // CODEX: Provider writes the next reply while DSH remains the only executor.
  replying: { zh: '生成回复中', group: 'running' },
  decided: { zh: '已判定', group: 'running' },
  sending: { zh: '发送中', group: 'running' },
  sent: { zh: '已发送', group: 'running' },

  // ── 暂停 / 终止档：全部要能解释「为什么停」 ──
  'needs-human': { zh: '待人工', group: 'paused', terminal: true },
  'retryable-failed': { zh: '可重试失败', group: 'paused' },
  failed: { zh: '失败', group: 'stopped', terminal: true },
  'lease-expired': { zh: '租约到期', group: 'stopped', terminal: true },
  'round-limit': { zh: '达轮数上限', group: 'paused', terminal: true },
  'budget-exhausted': { zh: '预算耗尽', group: 'paused', terminal: true },
  'global-takeover': { zh: '全局人工接管', group: 'stopped', terminal: true },
  'global-stop': { zh: '全局停止', group: 'stopped', terminal: true },
  'session-complete': { zh: '任务已完成', group: 'stopped', terminal: true },
  'session-missing': { zh: '会话不存在', group: 'stopped', terminal: true },
  'human-active': { zh: '人工已接手', group: 'stopped', terminal: true },
}

/** 相位中文名（未知相位原样回显，避免界面出现 undefined）。 */
export function phaseLabel(phase) {
  return PHASES[phase]?.zh ?? String(phase ?? '未知')
}

export function isTerminal(phase) {
  return PHASES[phase]?.terminal === true
}

/**
 * 停止原因的**人话解释**：状态不能只写「待人工」，必须说清是哪一类人工。
 * 键是机器原因码，值是界面/接口直接可读的中文。
 */
export const REASON_TEXT = {
  'disabled': '开关未开启',
  'no-decision-point': '当前没有待决策卡片',
  'already-handled': '这张卡片已经处理过',
  'locked-by-peer': '另一个实例正在处理这张卡片',
  'judging-in-flight': '本实例正在判断这张卡片',
  'retry-backoff': '发送失败，等待退避重试',

  // 人工档（红线 / 题型 / 判断不确定）
  'free-text': '自由文本提问，不代答',
  'multi-select': '多选提问，不代答',
  'multi-question': '一次多问，不代答',
  'empty-question': '提问为空',
  'unparseable': '决策卡片解析失败',
  'jev-unavailable': 'judge 不可用（超时或取不到凭据）',
  'jev-irreversible': '命中不可逆红线',
  'jev-unsure': 'judge 判断不确定',
  'blocked': 'judge 判定存在明确阻碍',
  'noul-missing': 'judge 未返回判断结果',
  'jev-undecided': 'judge 选择不在候选项内',
  'below-threshold': '置信度低于阈值',
  'no-fallback-tier': '没有可用容错档',

  // 预算 / 轮数 / 租约
  'round-limit': '达到最大连续推进轮数',
  'budget-exhausted': 'token 预算耗尽',
  'lease-expired': '租约已到期，等待重新开启或续期',
  'task-grant-missing': '任务授权不存在、已撤销或已过期，值守停止',
  'session-excluded': '通道或镜像会话默认不允许自动接管',
  'legacy-no-lease': '历史开关记录（旧格式，无租约），需重新开启',
  'legacy-migrated': '历史开关已迁移为过期记录',

  // 全局控制面
  'global-stop': '跨端全局停止（ui_control stop）',
  'global-takeover': 'the operator 已接管操作（ui_control takeover）',
  'global-paused': '跨端通道已暂停（ui_control pause）',

  // 会话侧
  'session-missing': '会话不存在或已被归档',
  'session-unavailable': '会话暂时读不到（存档/权限/忙碌）',
  'human-active': '检测到人工已在同一张卡片上作答',
  'stale-card': '卡片已被新的输出取代，按新版本重新处理',
  'agent-busy': '会话正忙，等待下一次扫描',
  'send-failed': '发送失败',
  'send-failed-retryable': '发送失败，可重试',
  'completion-evidence-confirmed': '完成标记与可核对证据均已确认',
  'completion-not-proven': '完成证据未达到项目标准，继续等待后续工作',
  'jev-blocked': 'judge 判断当前任务需要人工条件',
}

/** 把机器原因码翻成人话；`red-line:<类别>` 这类带参原因单独处理。 */
export function reasonText(reason) {
  const raw = String(reason ?? '')
  if (!raw) return ''
  if (REASON_TEXT[raw]) return REASON_TEXT[raw]
  if (raw.startsWith('red-line:')) {
    const category = raw.slice('red-line:'.length)
    return `命中红线：${category}`
  }
  return raw
}

/**
 * 状态摘要：每个相位对外都必须能回答同一组问题 —— 谁、到哪一步、还能跑多久、
 * 花了多少、最近一次提交是什么、最近一次回执是什么。
 *
 * @param record 租约记录（可能为 null）。
 * @param now 当前毫秒时间戳。
 */
export function statusSummary(record, now = Date.now()) {
  if (!record) {
    return {
      phase: 'off',
      phaseLabel: phaseLabel('off'),
      enabled: false,
      rounds: { completed: 0, max: null, remaining: null },
      lease: { expiresAt: null, remainingMs: null, expired: true },
      tokens: { used: 0, budget: null, jev: 0, dsh: 0, cacheRead: 0, unavailable: false },
      lastSubmission: null,
      lastReceipt: null,
      reason: 'disabled',
      reasonLabel: reasonText('disabled'),
      stopReason: null,
      since: null,
    }
  }
  const expiresAtMs = record.expiresAt ? Date.parse(record.expiresAt) : null
  const remainingMs = expiresAtMs === null ? null : Math.max(0, expiresAtMs - now)
  const max = Number.isFinite(record.maxRounds) ? record.maxRounds : null
  const completed = Number.isFinite(record.completedRounds) ? record.completedRounds : 0
  const budget = Number.isFinite(record.tokenBudget) ? record.tokenBudget : null
  const used = Number.isFinite(record.tokenUsed) ? record.tokenUsed : 0
  return {
    phase: record.phase ?? 'off',
    phaseLabel: phaseLabel(record.phase ?? 'off'),
    enabled: record.enabled === true,
    owner: record.owner ?? null,
    instanceId: record.instanceId ?? null,
    triggerSource: record.triggerSource ?? null,
    rounds: { completed, max, remaining: max === null ? null : Math.max(0, max - completed) },
    lease: {
      leaseId: record.leaseId ?? null,
      enabledAt: record.enabledAt ?? null,
      lastActivityAt: record.lastActivityAt ?? null,
      expiresAt: record.expiresAt ?? null,
      remainingMs,
      expired: expiresAtMs !== null && expiresAtMs <= now,
    },
    tokens: {
      used,
      budget,
      remaining: budget === null ? null : Math.max(0, budget - used),
      jev: record.jevTokens ?? 0,
      dsh: record.dshTokens ?? 0,
      cacheRead: record.cacheReadTokens ?? 0,
      unavailable: record.tokensUnavailable === true,
    },
    lastSubmission: record.lastSubmission ?? null,
    lastReceipt: record.lastReceipt ?? null,
    reason: record.reason ?? null,
    reasonLabel: reasonText(record.reason),
    stopReason: record.stopReason ?? null,
    stopReasonLabel: record.stopReason ? reasonText(record.stopReason) : null,
    at: record.updatedAt ?? null,
    since: record.enabledAt ?? null,
  }
}
