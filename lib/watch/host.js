// 值守引擎（原 watchkeeper，2026-10-15 搬进值守台）—— 宿主半（DSH 进程内）
//
// 职责：把会话中途的提问与正文决策卡交给 judge 判断，在**明确边界内**自动推进。
//
// 边界由四件事共同定义（缺一不可）：
//   1. **租约**（lib/lease.js）：接管有开始/到期时间、轮数上限、token 预算；到期即停。
//   2. **事务状态机**（lib/outbox.js）：judging → decided → sending → committed；
//      只有拿到 DSH 明确成功回执才写 committed，失败落 retryable-failed 并按退避重试。
//   3. **跨进程操作锁**（lib/outbox.js）：Desktop 与 Web 共享同一把「会话+卡片指纹」锁，
//      只有持锁者能发送；先发者的完成记录对后发者可见。
//   4. **全局控制面**（lib/control.js）：只读 ui-control 的 stop / takeover，
//      不建立第二套停止机制。
//
// 红线：凭据、资金、不可逆动作、身份核验一律不经 judge，直接 `next()` 转人工。
//
// 两条触发轨（都在宿主侧，不模拟鼠标、不抢焦点）：
//   · `user-questions/request`（瀑布事件）：模型弹选择框时抢答或让给界面；
//   · `session/event` 的 `turn/end` + 周期扫描：读**正文**里的 `[DECISION_POINT]` 自驱动。

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ROOT, stateDir, FILES } from './paths.js'
import {
  appendJsonl, ensureDir, fingerprintOf, instanceId, normalizeText, nowIso,
  readJson, redact, summarize, withFileLock, writeJsonAtomic,
} from './store.js'
import {
  accountDshUsage, accountJudgeUsage, accountRound, budgetGuardForJudge, disableLease,
  enableLease, getLease, leaseVerdict, listLegacy, listLeases, patchLease, persistMigration,
  readAutoReplies, rememberAutoReply,
} from './lease.js'
import { globalGate, readGlobalControl } from './control.js'
import {
  acquireDecisionLock, backoffMs, evidenceSummary, findMarkedUserMessages, foldSessionUsage,
  findOp, latestOp, listDecisionLocks, markStale, pruneOps, readDecisionLock,
  readOps, releaseDecisionLock, touchDecisionLock, upsertOp,
} from './outbox.js'
import { reasonText, statusSummary } from './machine.js'
import { loadJudgmentProfile } from './judgments.js'
import { evaluateSession, complianceOfText } from './evaluator.js'
import { evaluateConstraint, gateMode, recordShadow } from './constraint-gate.js'
import { generateReply } from '../reply.js'
import { activeProviders, loadToggles } from '../providers.js'

export const name = 'dsh-watchkeeper'
export const inject = []

/**
 * **已加载代码的版本标记**（2026-10-13 加）。
 *
 * 为什么要有它：插件宿主半只在 **DSH APP 启动时** import 一次（`entry.js` 的 cache-busting 只在重挂时生效），
 * 所以「文件已改」不等于「内存已生效」。实测踩过：两次「重启过了」，进程起始时刻仍停在几小时前，
 * 而单看行为又分不清当前跑的是哪一版（`/watchkeeper/watch/decide` 走的是 `judge()`，free-text 恒判 human，不能当版本探针）。
 *
 * 口径：`ready` 日志与 `/watchkeeper/watch/health` 都带这个串，重启后读日志即可确认**实际加载版本**
 * （对应 `ops/docs/rule-lifecycle.md` 的「有效版本 vs 实际加载版本」区分）。
 * **每次影响运行行为的改动都要改这个串。**
 */
export const CODE_REVISION = '2026-10-15-parallel-provider-session-takeover-v2'

const optionalControllers = new WeakMap()
const optionalRuntimes = new WeakMap()
function runtimeService(ctx, name) {
  const value = optionalRuntimes.get(ctx)?.[name]; if (value) return value
  try { return ctx.get?.(name) || ctx[name] } catch { return undefined }
}
function optionalSessionController(ctx) {
  if (optionalControllers.has(ctx)) return optionalControllers.get(ctx)
  try { return ctx.get?.('sessionController') || ctx.sessionController } catch { return undefined }
}

/** Judge command, if configured: reads one JSON object on stdin, prints one on stdout. */
function judgeCommand() {
  const raw = CONFIG.judgeCommand || process.env.WATCHKEEPER_JUDGE_CMD
  return raw ? String(raw) : null
}

/** 红线：命中即不经 judge，直接转人工。写死，不给概率机会。真实资金动作不包含纯查询/抓取采购价与成本。 */
const RED_LINES = [
  ['凭据与身份核验', /凭据|密码|passwo?rd|token|api[\s_-]?key|私钥|secret|验证码|身份|实名|kyc|verif/i],
  ['真实资金转移', /付款|支付|充值|提现|转账|退款|退费|扣款|汇款|refund|结算|下单(?!规则)|(?:执行|确认|立即)采购|采购扣款|pay(ment)?|checkout|withdraw|transfer\b/i],
  ['不可逆或对外发布', /发布|上线|提交|删除|清空|发送给|publish|deploy|delete|drop\b|submit/i],
]

/**
 * 红线扫的是「这张卡要不要动手」，不是词面。
 *
 * 实测事故（2026-10-03，`session-f75bba2f`）：推进档写「只写本机证据，不碰平台、**不提交**」，
 * 「不提交」里的「提交」命中红线 → 整卡判 `red-line:不可逆或对外发布` → 值守读到了卡却接管不了。
 * 留痕：`decisions.jsonl` 该会话 22:47:50 `outcome: human / reason: red-line:不可逆或对外发布`。
 *
 * 所以命中要看**紧邻的否定词**：不 / 无需 / 未 / 免 … 开头的一律不算。
 */
const NEGATION_TAIL = /(?:不|无需|无须|未|免|勿|别|不用|不必|禁止|没有|never|not|no|without)\s*$/i

/** 命中位置前面 4 个字符里，紧挨着的是不是否定词。 */
export function negatedAt(text, index) {
  return NEGATION_TAIL.test(String(text).slice(Math.max(0, index - 4), index))
}

/** 红线命中判定：带否定语境的命中不算；返回类别名，没命中返回 null。 */
export function hitRedLine(text) {
  const source = String(text ?? '')
  for (const [label, pattern] of RED_LINES) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const rx = new RegExp(pattern.source, flags)
    let m
    while ((m = rx.exec(source)) !== null) {
      if (!negatedAt(source, m.index)) return label
      if (rx.lastIndex === m.index) rx.lastIndex += 1
    }
  }
  return null
}

/**
 * 「停车问句」——把「等你发话才继续」当成不合格收尾，代之以自主续跑（the operator 2026-10-12 定）。
 *
 * 事故形态（实测，31 轮的那条会话）：模型把决策卡写成
 * 「① 你回来说继续跑，我核对后按序推六项 / ② 你说合并定稿我并两方产物往下走」，
 * 再配上 checkpoint `final-hold-no-progress-awaiting-user` —— **门是模型自己关上的**，
 * 值守回一次它就再停一次，最终升级成 red-line-repeat。
 *
 * 判定按**动作短语**，不按单个词：
 *   · 「你回来说继续」是停车；「等你给采购价表」不是（那两类信息只有人能提供，必须交人）；
 *   · 红线优先：卡上同时有红线时不做停车代答，仍走红线转人工 —— 这是**收窄**，放行面净减少。
 */
const PARKING_PATTERNS = [
  /回来说(?:继续|接着)/,
  /回来(?:我)?再(?:说|继续)/,
  /等(?:你|您)(?:回来|确认|回复|答应|批准|点头|指示|同意)[^。；\n]{0,8}(?:继续|接着|再跑|往下|推进)/,
  /await(?:ing)?\s+(?:for\s+)?(?:your|the)\s+(?:confirmation|approval|reply|response|go-ahead)/i,
  /waiting\s+for\s+(?:you|your|the)\s+(?:confirmation|approval|reply|response|go-ahead)/i,
  /once\s+you\s+(?:confirm|reply|say|approve)\b/i,
  /tell\s+me\s+to\s+continue\b/i,
]

/** 停车问句判定：返回命中的模式（便于留痕），没命中返回 null。 */
export function hitParkingQuestion(text) {
  const source = String(text ?? '')
  if (!source) return null
  for (const pattern of PARKING_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const rx = new RegExp(pattern.source, flags)
    let m
    while ((m = rx.exec(source)) !== null) {
      if (!negatedAt(source, m.index)) return pattern.source
      if (rx.lastIndex === m.index) rx.lastIndex += 1
    }
  }
  return null
}

/**
 * 自动提交到会话的可见来源标记。
 *
 * 口径（the operator 2026-10-03 + 本次 P0 验收）：标记**必须落在消息正文里**。
 * 理由不是好看，而是**可验证**：崩溃恢复要靠平台读回判断「这条消息到底发出去了没有」，
 * 没有正文标记就只能靠猜 —— 而猜错一次就是重复发送。界面半另有橙色气泡 chip 做视觉强调。
 */
// CODEX: Visible provenance joins judge's judgment with the selected reply-only provider.
const AUTO_REPLY_PREFIX = '[watchkeeper'

/** 自主续跑的来源标记（值守自己注入的消息都以此开头，读回时必须能认出来）。 */
const AUTO_CONTINUE_PREFIX = '[watchkeeper · auto-continue]'

/** 投递进会话前的机械规范化：实现已上移到共享纯函数（唯一 home）。
 *
 * 为什么是机械做而不是只写在提示词里：提示词是「要求」，模型可能不照做；
 * 这条消息既是 Provider 的输出、又是 DSH 会话的输入，格式错了 the operator 就得自己拆句。
 * 口径唯一归属 ops/docs/input-format.md §三、ops/docs/output-format.md §三；
 * 实现唯一归属 integrations/io-format/normalize.mjs（本文件只 re-export，保持既有调用方与测试不变）。
 */
import { normalizeReplyFormat, safeNormalizeReplyFormat } from '../io-format/normalize.mjs'
const replyAuthorityUrl = new URL('./reply-authority.js', import.meta.url)
replyAuthorityUrl.searchParams.set('v', new URL(import.meta.url).searchParams.get('v') || String(Date.now()))
const { guardReplyAuthority, REPLY_AUTHORITY, EXECUTION_FIRST, WATCH_RESPONSIBILITY, WATCH_RESPONSIBILITY_REVISION } = await import(replyAuthorityUrl.href)

export { normalizeReplyFormat, safeNormalizeReplyFormat }

export function formatAutoReply(picked, provider = null, generated = null) {
  const names = Array.isArray(provider) ? provider.map(id => ({ codex: 'codex', agy: 'agy', custom: 'custom' }[id] || id)) : []
  const providerName = provider === 'codex' ? 'codex' : provider === 'agy' ? 'agy' : provider === 'custom' ? 'custom' : null
  const groupName = names.length > 1 ? `${names.join(' / ')} group` : names[0]
  const marker = groupName ? `[watchkeeper · ${groupName}]` : providerName ? `[watchkeeper · ${providerName}]` : '[watchkeeper]'
  const body = normalizeReplyFormat(guardReplyAuthority(generated || picked).text)
  // 首行 = 来源标记 **+ 一句话结论**：the operator 2026-10-10 骨架第 1 条（身份 + 结论），
  // `preference_lint.py` 检查项 26 会拦「只有标记、没有结论」——2026-10-15 插件体检实测命中。
  const conclusion = String(picked ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'judged'
  const prefix = `${marker} ${conclusion}`
  return body ? `${prefix}\n${body}` : prefix
}

// CODEX: a reply provider may answer ordinary judge uncertainty, but the visible prefix must show the handoff.
export function formatFallbackReply(generated) {
  const body = normalizeReplyFormat(guardReplyAuthority(generated).text)
  const prefix = '[watchkeeper · fallback] handoff to a reply provider'
  return body ? `${prefix}\n${body}` : prefix
}

/** 值守代答的准入白名单（**2026-10-12 the operator 扩权**：从「只答单选卡」到「按店主立场自办」）。
 *
 * the operator 原话：「站在我的角度去判断：只要不涉及登录门禁和资金充值门禁，其他的他都可以自己决定。
 * 我想要的就是 AI 能够完成所有自己的业务模块并实现盈利。」
 *
 * 因此本函数只挡两类**人工门禁**：
 *   · 资金：付款 / 充值 / 提现 / 采购 / 佣金承诺 / 投流花费（`RED_LINES[1]`，含 reason 与 context 双查）
 *   · 登录：凭据与身份核验 —— 密码 / token / api key / 私钥 / 验证码 / 实名（`RED_LINES[0]`）
 *
 * 仍交人的两类**非门禁**情形（保留原因见 ops/decisions/2026-10-12-agent-autonomy-except-login-and-money.md）：
 *   · 设计机制问题：规则 / 门禁 / 授权边界 / 口径 / 流程设计本身（the operator 2026-10-12 仍自留复核）；
 *   · 镜像与对外通道会话：对面是真人，代答等于以店主身份对外发言（由 excludedSessionPrefixes 挡，不在此处判）。
 */
export function canFallbackReply(reason, context = '') {
  if (faultHit('judge-bad-json')) return false
  if (!reason) return false
  const text = String(context)
  // 资金门禁：reason 或上下文命中任一即交人。
  if (String(reason).includes('真实资金转移') || RED_LINES[1][1].test(text)) return false
  // 登录门禁：凭据与身份核验一律交人（含 Agent 过不去的验证码）。
  if (LOGIN_GATE.test(text)) return false
  // 设计机制问题仍归 the operator（规则 / 门禁 / 授权边界 / 口径 / 流程设计本身），业务执行类问题不在此列。
  if (isDesignMechanismQuestion(text)) return false
  return true
}

/**
 * 登录门禁的**精确**判据（不用 `RED_LINES[0]` 的宽表）。
 *
 * 为什么不直接复用 `RED_LINES[0]`：那张表含「身份」这种宽词，
 * 会把「达人身份核验怎么做」「店铺身份信息」这类正常业务问答也一并挡掉 —— 与本次扩权相反。
 * 这里只认真正的门禁动作：要凭据、要密码、要验证码、要实名/身份核验。
 */
const LOGIN_GATE = /凭据|密码|passwo?rd|token|api[\s_-]?key|私钥|secret|验证码|captcha|实名|身份核验|kyc|verif/i

/** 设计机制类问题判据：命中即交 the operator 复核（口径唯一归属见本文件上方注释与同名决策记录）。 */
export function isDesignMechanismQuestion(text = '') {
  return /设计机制|授权边界|门禁规则|规则本身|口径本身|流程设计|制度设计|审批边界/.test(String(text))
}

const disposedContexts = new WeakSet()

const COMPLETION_MARKER = '任务状态：已 100% 完成'

/** CODEX: A normal stop needs both the fixed completion marker and explicit evidence. */
export function completionEvidence(text) {
  const source = String(text ?? '')
  if (!source.includes(COMPLETION_MARKER)) return { complete: false, reason: 'marker-missing' }
  if (!/(?:判据|证据)\s*[:：]\s*\S+/.test(source)) return { complete: false, reason: 'evidence-missing' }
  return { complete: true, reason: 'completion-evidence-confirmed' }
}

export function replyPrompt({ provider, parsed, picked, detail }) {
  return [
    'You write the next user reply for a DeepSeek Harness (DSH) session.',
    'Do not execute tools and do not claim work was done.',
    REPLY_AUTHORITY,
    EXECUTION_FIRST,
    WATCH_RESPONSIBILITY,
    'Write exactly one complete reply addressed to the DSH agent, saying what to do next.',
    'Return only the reply text, with no prefix and no explanation.',
    `Provider: ${provider}`,
    '',
    'Formatting: one item per line, short paragraphs, no divider lines, no headings.',
    'If you state that something is complete, include the checkable evidence.',
    '',
    'Question:', String(parsed?.question ?? ''),
    'Context:', sanitizeContext(parsed?.context) ?? 'none',
    'Selected option:', String(picked ?? ''),
    'Reason:', String(detail?.reason ?? 'selected by the judge'),
  ].join('\n')
}

/** CODEX: a reply provider/a reply provider only generate a reply; DSH remains the sole executor. */
export async function generateProviderReply({ provider, parsed, picked, detail, ctx, sessionId }) {
  const list = Array.isArray(provider) ? provider : (provider && provider !== 'none' ? [provider] : [])
  if (!list.length) return { provider: null, text: picked, fallback: true }
  if (!Array.isArray(provider)) {
    if (hooks.reply) return hooks.reply({ provider, parsed, picked, detail })
    if (hooks.judge) return { provider, text: picked, fallback: true }
  }
  const prompt = replyPrompt({ provider: list.join(', '), parsed, picked, detail })
  const results = await Promise.all(list.map(async id => {
    try { return { provider: id, ...(await generateReply({ provider: id, prompt, timeoutMs: CONFIG.replyTimeoutMs ?? 120_000 })) } }
    catch (error) { return { provider: id, error: describeError(error) } }
  }))
  const successful = results.filter(result => result.text)
  const failed = results.filter(result => result.error)
  if (!successful.length) {
    return { provider, text: picked, fallback: true, replyError: failed.map(x => `${x.provider}: ${x.error}`).join('; ') || 'no provider reply' }
  }
  const text = successful.map(result => `[${result.provider}]\n${result.text}`).join('\n\n')
  return {
    provider,
    text,
    partial: failed.length > 0,
    replyError: failed.length ? failed.map(x => `${x.provider}: ${x.error}`).join('; ') : null,
  }
}

/** 界面半识别自动回复用的环形清单长度（重启后历史气泡标记不丢）。 */
const AUTO_REPLY_KEEP = 100

/**
 * Provider 生成回复失败**不许静默**（2026-10-11 定）。
 *
 * 旧代码让 `generateReply` 的异常一路冒到事件处理器：会话不推进、界面也看不出为什么，
 * 表现与「值守不起作用」一模一样（这正是 2026-10-11 那次排查里最难分辨的一层）。
 * 现在失败也照常投递：正文退化为 **judge 选中的那一档原文**，带同一行 Provider 标记，
 * 并在 ops 记录里留 `replyError`（谁失败、原话是什么），下一轮扫描可据此复查。
 */
async function safeProviderReply({ provider, parsed, picked, detail, sessionId, ctx }) {
  try {
    return await generateProviderReply({ provider, parsed, picked, detail, ctx, sessionId })
  } catch (error) {
    const replyError = describeError(error)
    log({ type: 'reply-failed', sessionId, provider, detail: replyError })
    return { provider, text: picked, fallback: true, replyError }
  }
}

/**
 * 代答质量门（the operator 2026-10-12 追定：「回答不可以糊弄，dsh Agent 必须有高质量的分析和决策回答」）。
 *
 * 判定分两档，**必须先有内容、再谈推回**：
 *   · 硬不合格（必拦）：推回型空话 —— 「你自己决定 / 看情况 / 都可以 / 视具体情况而定」；
 *   · 提示不合格（留痕）：既没有可核对依据（判据 / 依据 / 来源 / URL / 路径 / 命令输出 / 平台读回），
 *     也没有给结论（推荐 / 结论 / 建议执行 / 第一步）。
 *
 * 为什么「推回」是必拦而不是提示：把决定推回给 the operator 正是值守失效的原始症状，
 * 放开代答却没拦住推回，等于把「不起作用」换个说法留着。
 *
 * @returns `{ ok, reason, hard }` —— `ok=false` 时调用方应退化为交人，不许当正常答复投递。
 */
export function checkAnswerQuality(text = '') {
  const source = String(text ?? '').trim()
  if (!source) return { ok: false, hard: true, reason: 'empty-answer' }
  const EVASION = /你自己决定|自己决定吧|看情况|视具体情况而定|都可以|随便你|建议综合考虑|结合实际情况/i
  if (EVASION.test(source)) return { ok: false, hard: true, reason: 'evasive-answer' }
  // 实质条件只作**提示档**：写没写依据/结论交给评估人格与人工复核去判，
  // 机器只硬拦「空答」与「推回」（拦多了会把正常短答误判成不合格，2026-10-12 实测过）。
  const EVIDENCE = /判据|依据|来源|出处|https?:\/\/|[\w./-]+\.(?:py|js|mjs|md|json|yml|yaml)\b|退出码|读回|官方/i
  const CONCLUSION = /(?:建议|推荐|结论|方案是|第一步|应当|结论：)/
  const substantive = EVIDENCE.test(source) || CONCLUSION.test(source)
  return { ok: true, hard: false, reason: substantive ? 'answer-substantive' : 'answer-substance-advisory' }
}


/** 插件默认配置；部署相关取值由 cordis 配置覆盖。 */
export const Config = {
  taskTool: { enabled: true },
  /**
   * 闸门分界 —— **不再是**「自动 / 转人工」的分界：
   *   forward ≥ 此值              → 走 ① 推荐档
   *   1−此值 < forward < 此值     → 走 ② 容错档（保守推进）
   *   forward ≤ 1−此值            → 转人工（证据明确反对推进）
   */
  approveThreshold: 0.7,
  /** 默认是否对全部会话开启值守（会话级开关未显式设置时使用）；默认关，新会话不会被自动接管。 */
  defaultEnabled: false,
  /**
   * **永不自动员的会话**（显式 id 名单）。
   * 为什么要有：通道镜像窗口（飞书 IM / 微信 IM）里对面是**真人**，
   * judge 替人作答等于以店主身份对外发言；这类会话必须靠配置一刀切挡住，
   * 不能只依赖 defaultEnabled 这个「默认值」（the operator 2026-10-04 定）。
   */
  excludedSessions: [],
  /**
   * 永不自动员的会话 id **前缀**名单，**默认挡住两类**：
   *   · `mirror-`  通道镜像窗口（只读归档，对面不是真人但在窗口里发的消息不会被送出去）
   *   · `feishu-` / `weixin-` DSH 通道会话（**对面是 the operator 本人**，judge 代答等于冒充店主对外发言）
   * 定成默认值而不是 profile 配置：这样任何 profile、任何部署都不会漏配；
   * 要放开必须显式写 `excludedSessionPrefixes: []`，是有意识的决定。
   */
  excludedSessionPrefixes: ['mirror-', 'feishu-', 'weixin-'],
  /** 周期扫描间隔（毫秒）；<=0 关闭。 */
  sweepIntervalMs: 60_000,
  /** 轮次只统计，不作为停止条件。保留字段仅兼容旧状态与旧 profile。 */
  maxRounds: null,
  /** token 预算（judge 判断 + DSH 主回合合计）：默认 $3 USD（按 DeepSeek 缓存读折算约 2 亿 token）。 */
  tokenBudget: 200_000_000,
  /** 租约有效期（毫秒）：默认 24 小时，到期不再判断、不再发送，等 the operator 重新开启或续期。 */
  leaseTtlMs: 24 * 60 * 60 * 1000,
  /** 决策锁 TTL：持有者崩溃后，另一端最多等这么久即可接管（接管前必先平台读回）。 */
  lockTtlMs: 90_000,
  /** Judge command (executable + args). Empty = no judge, everything goes to the human. */
  judgeCommand: '',
  /** Hard timeout for one judge call in milliseconds; on timeout the card goes to the human. */
  judgeTimeoutMs: 30_000,
  /** 送去 judge 的 context 字符硬上限（最小输入原则：不发送完整会话历史）。 */
  maxContextChars: 1200,
  /** 崩溃恢复宽限期：比这个更年轻的 sending/judging 记录视为「可能仍在跑」。 */
  recoveryGraceMs: 30_000,
  /** CODEX: DSH remains executor; default off for all reply providers. */
  defaultReplyProvider: 'none',
  /** Profile name used to load completion/evaluation wording from config/judgments.json. */
  judgmentProject: 'default',
  /**
   * **自主续跑**（the operator 2026-10-12 定：开了值守就该一路干到完成，不该停在「等你发话」）。
   *
   * 两种触发：
   *   ① 模型把决策卡写成了停车问句 → 判 `continue`，直接续跑，不比概率（护栏见 hitParkingQuestion）；
   *   ② 一轮结束、既没证明完成、正文里也没有决策卡 → 注入一轮「继续执行」。
   *
   * 三条件缺一不可：会话开关开着（lease.enabled）、租约未到期、预算未耗尽 ——
   * 与其它判定共用同一道租约闸门，不另开一条绕过闸门的路。
   * 护栏：同一段正文只续一次（指纹去重，防原地打转）、单条租约最多 maxAutoContinues 次。
   */
  autoContinue: false,
  /**
   * **评估人格**（the operator 2026-10-12 定；同日撤掉质量打分轴）：会话收尾时由独立评审员裁两轴 ——
   *   ① 完成轴：原始任务是否做完（证据分层，低层不冒充高层）
   *   ② 合规轴：**确定性规则命中**（红线 / 门禁读回证据），不交 judge 判
   * 两条全过才是正常终点；不过就继续想办法，不在收尾停手。
   * 判据与话术的唯一归属：integrations/watchkeeper/config/judgments.json 的 `evaluation` 段。
   * 置 false 才退回旧的三条件概率判据（仅在评估器故障时作对照用，不建议线上开）。
   */
  evaluator: true,
  /**
   * 续跑冷却：连续续跑到上限后只**暂停**，等这么久自动放行继续跑 ——
   * 不是终止条件，不需要 the operator 做任何事（the operator 2026-10-12：只有任务完成才停）。
   */
  autoContinueCooldownMs: 30 * 60 * 1000,
  /** 自主续跑上限（每一段，不含冷却放行）：到顶即进入冷却并留痕，不静默。 */
  maxAutoContinues: 40,
  /**
   * 连着看到同一段正文多少次才认「真推不动」（默认 3）。
   * 为什么不是 1：正文没变的常见原因是**这一轮还没跑完**，一见即停会误杀正在干活的会话
   * （实测：2026-10-12「1-业务运营」33 轮会话就是这样被停的）。
   */
  autoContinueStallAfter: 3,
}

function log(event) {
  try {
    console.log('[watchkeeper]', JSON.stringify(event))
  } catch { /* 日志失败不得影响会话 */ }
}

function appendDecision(entry) {
  appendJsonl(FILES.decisions, entry, (error) => {
    log({ type: 'decision-append-failed', message: String(error?.message ?? error) })
  })
}

/**
 * 判定留痕字段（**只记账，不改判定**，2026-10-12 值守裁定）：
 *   · `red_line`     —— 正文命中了哪一类红线（`credentials` / `money` / `action`）；未命中写 `'none'`。
 *   · `evidence_hit` —— 正文是否出现门禁/读回证据词（布尔）。
 *
 * 为什么只加字段：原先 `evaluation-blocked` 只写 `reason=compliance-violation`，
 * 事后看不出「是被哪个词绊倒」还是「压根没写证据」。这两条对应完全不同的修法，
 * 却记成同一行 —— 补上字段即可分辨，判定与护栏一律不动。
 */
function complianceTrace(text) {
  try {
    const c = complianceOfText(text)
    // red_line 落**类别名**（credentials / money / action / none），不是正则原文 ——
    // 正则原文落账本读起来太吵；判定仍以 complianceOfText 的 choice 为准。
    // Keep hot reload compatible with an evaluator module cached before
    // hitRedLineCategory was added. complianceOfText already returns the same
    // category and was present in the earlier runtime module.
    return { red_line: c?.redLine ?? null, evidence_hit: c?.evidenceHit === true }
  } catch {
    return { red_line: 'unavailable', evidence_hit: false }
  }
}

/**
 * 影子留痕（**只记账，不影响判定**）：把「约束回流门本来会怎么处置」记进账本，
 * 供准入决策时回答「这道门挡了多少、会不会少自动」。任何异常都吞掉 ——
 * 记账失败绝不能影响会话（与 `appendDecision` 同纪律）。
 */
function recordShadowSafe(constraint, outcome) {
  if (!constraint || constraint.verdict === 'allow') return
  try {
    recordShadow(constraint, outcome)
  } catch (error) {
    log({ type: 'constraint-shadow-failed', message: String(error?.message ?? error) })
  }
}

ensureDir(stateDir())

// ---------------------------------------------------------------- 故障注入（仅测试）

/**
 * 故障注入开关：`WATCHKEEPER_FAULTS=send-fail-once,jev-timeout,...`
 *
 * 为什么要内建：验收要求「主动制造异常，而不是只测正常路径」。把注入点放进生产代码，
 * 故障场景才会走**真实路径**；写成外挂脚本只能测到替身，证明不了生产分支。
 * 生产环境不设这个变量，所有分支都会跳过。
 */
const FAULTS = new Set(String(process.env.WATCHKEEPER_FAULTS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean))
const faultHits = new Map()

export function faultHit(name) {
  if (!FAULTS.has(name)) return false
  const used = faultHits.get(name) ?? 0
  faultHits.set(name, used + 1)
  if (name.endsWith('-once') && used >= 1) return false
  return true
}

/** 测试挂钩：替换 judge 判断、投递实现与评估人格（生产恒为 null）。 */
const hooks = { judge: null, prompt: null, reply: null, now: null, evaluate: null }
export const __test = {
  setHooks(patch) { Object.assign(hooks, patch) },
  reset() {
    hooks.judge = null
    hooks.prompt = null
    hooks.reply = null
    hooks.now = null
    hooks.evaluate = null
    faultHits.clear()
  },
  faults: FAULTS,
}

function clock() {
  return hooks.now ? hooks.now() : Date.now()
}

// ---------------------------------------------------------------- judge 判断

/**
 * Ask the configured judge command for a decision.
 *
 * Contract: one JSON object on stdin —
 *   { sessionId, question, header, context, options: [label], thresholds: { approve } }
 * One JSON object on stdout —
 *   { decision: "answer" | "human" | "continue", selected, confidence, reason }
 *
 * Any failure (no command, exit code, timeout, bad JSON, unknown option, confidence
 * below the threshold) resolves to null, and the caller always treats null as
 * "hand it to the human". There is no silent auto-answer without a judge.
 */
function askJudge(state, questions) {
  if (hooks.judge) return hooks.judge(state, questions)
  if (faultHit('judge-timeout')) return Promise.resolve(null)
  const command = judgeCommand()
  const options = Array.isArray(state?.options) ? state.options : []
  if (!command || !options.length) return Promise.resolve(null)
  const payload = {
    sessionId: state.session_id ?? null,
    question: String(state.question ?? ''),
    header: state.header ?? null,
    context: state.context ?? null,
    options,
    thresholds: { approve: CONFIG.approveThreshold },
  }
  return new Promise((resolve) => {
    let settled = false
    let child
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    try { child = spawn('/bin/sh', ['-lc', command], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }) }
    catch { finish(null); return }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
      log({ type: 'judge-timeout', afterMs: CONFIG.judgeTimeoutMs })
      finish(null)
    }, Math.max(1000, Number(CONFIG.judgeTimeoutMs) || 30_000))
    if (typeof timer.unref === 'function') timer.unref()
    let out = ''
    let err = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      log({ type: 'judge-spawn-failed', message: String(error?.message ?? error) })
      finish(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        log({ type: 'judge-exit', code, stderr: redact(err, 400) })
        finish(null)
        return
      }
      let parsed
      try { parsed = JSON.parse(out) } catch (error) {
        log({ type: 'judge-parse-failed', message: redact(error?.message, 200) })
        finish(null)
        return
      }
      finish(judgeAnswers(parsed, state))
    })
    try { child.stdin.end(JSON.stringify(payload)) } catch { /* the child may already be gone */ }
  })
}

/** Map the simple judge reply into the answers shape the decision logic consumes. */
export function judgeAnswers(parsed, state) {
  const decision = String(parsed?.decision ?? '').toLowerCase()
  const selected = typeof parsed?.selected === 'string' ? parsed.selected : null
  const confidence = Number(parsed?.confidence)
  const options = Array.isArray(state?.options) ? state.options : []
  if (decision !== 'answer' || !selected || !options.includes(selected) || !Number.isFinite(confidence)) return null
  const probability = Math.max(0, Math.min(1, confidence))
  const answers = {
    pick: { choice: selected, probabilities: { [selected]: probability } },
    unsure: { noul: 0 },
    blocked: { noul: 0 },
    irreversible: { noul: 0 },
    completion: { noul: 1 },
  }
  if (state?.forward_option) {
    answers.forward = { noul: selected === state.forward_option ? probability : 1 - probability }
  }
  return { answers, usage: parsed?.usage ?? null }
}

/** judge 返回的 usage 归一化（缓存读与未缓存输入分列，不合并）。 */
export function normalizeJudgeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? (inputTokens + outputTokens)) || 0
  const cacheReadTokens = Number(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? 0) || 0
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    costUsd: Number(usage.cost_usd ?? usage.costUsd ?? 0) || 0,
  }
}

/**
 * context 最小化：硬截断 + 脱敏；绝不把完整会话历史或凭据送进判断层。
 *
 * 2026-10-05：`context` 按 `ops/docs/jev.md` §10.4 规定写成**分段数组**（每段一行、带标签），
 * 目的是让人一眼分段。判断层拿到的仍是**一段文本**（段间用「；」连接），证据不丢；
 * 统计口径 `contextChars` 也随之落在拼好的文本上，不会退化成数组元素个数。
 */
export function sanitizeContext(context) {
  if (!context) return null
  const text = Array.isArray(context)
    ? context.map((seg) => String(seg ?? '').trim()).filter(Boolean).join('；')
    : String(context)
  if (!text) return null
  return redact(text, Number(CONFIG.maxContextChars) || 1200)
}

/**
 * 查询约束回流门。**任何异常都降级为 allow** —— 读不到约束不是会话的错误，
 * 插件绝不能因为经验文件损坏而把提问流程打断（AGENTS.md §6「拔掉不崩」）。
 *
 * 三种模式（`WATCHKEEPER_CONSTRAINT_GATE`）：
 *   · 未设 / shadow —— 只留痕：结果进 decisions.jsonl 的 `constraintGate` 字段，判定照旧
 *   · on            —— 命中生效：不稳定约束要求补证据后交人，已固化约束直接交人
 *   · enforce       —— 同 on（保留档位，便于后续区分「只拦不稳定」与「全拦」）
 */
function lookupConstraint(question, { sessionId } = {}) {
  const mode = gateMode()
  let result
  try {
    result = evaluateConstraint(question, { mode })
  } catch (error) {
    log({ type: 'constraint-gate-error', mode, message: summarize(String(error?.message ?? error), 160) })
    return null
  }
  if (!result || result.verdict === 'allow') return result
  log({ type: 'constraint-gate-hit', mode, verdict: result.verdict, rule: result.rule?.id ?? null, sessionId })
  if (mode === 'shadow') return { verdict: result.verdict, reason: result.reason, ruleId: result.rule?.id ?? null }
  return result
}

/**
 * 把一次提问（或合成提问）判成「给哪个答案」。
 * @returns `{ kind, reason, detail, answer? }`：kind 为 `answer` 时 answer 可直接回给模型。
 */
async function judge(questions, sessionId) {
  const items = Array.isArray(questions) ? questions : []
  const first = items[0]
  if (!first) return { kind: 'human', reason: 'empty-question' }
  if (items.length > 1) return { kind: 'human', reason: 'multi-question' }

  const options = Array.isArray(first.options) ? first.options : []
  if (options.length === 0) return { kind: 'human', reason: 'free-text' }
  if (first.multiSelect === true) return { kind: 'human', reason: 'multi-select' }

  const labels = options.map((option) => String(option.label))

  const haystack = [first.question, first.header, first.detail, ...labels].filter(Boolean).join('\n')

  // 红线优先于停车：卡上有红线就不做停车代答，仍交人（自办面净减少，不放宽任何既有红线）。
  const redLine = hitRedLine(haystack)
  const parking = redLine ? null : hitParkingQuestion(haystack)

  // 约束回流门（反思 → 判断的消费端，见 lib/constraint-gate.js）：
  // 经验 Agent 提炼的负向约束在这里**第一次被真正读取**。默认影子，只留痕；
  // `WATCHKEEPER_CONSTRAINT_GATE=on` 才真的影响判定，=enforce 才允许直接交人。
  // 刻意放在红线判定**之前**：红线路径也要留痕，否则对账会漏掉最该看的那一类。
  const constraint = lookupConstraint(first.question, { sessionId })

  if (redLine) {
    recordShadowSafe(constraint, 'human')
    return { kind: 'human', reason: `red-line:${redLine}` }
  }

  // 停车问句：卡在「等你发话」上不是待答问题，是收尾不合格 —— 直接续跑（the operator 2026-10-12 定）。
  if (parking) {
    recordShadowSafe(constraint, 'continue')
    appendDecision({
      sessionId,
      question: summarize(first.question, 200),
      options: labels,
      outcome: 'parking-continue',
      reason: 'parking-question',
      parkingPattern: parking,
      at: nowIso(clock()),
    })
    return { kind: 'continue', reason: 'parking-question', detail: { parkingPattern: parking } }
  }

  // 准入模式（`on` / `enforce`）：命中约束即在本轮生效。
  // `hold` = 已固化约束（历史上只失败过）→ 交人；`ask-evidence` = 不稳定约束 → 要求补证据。
  // 影子模式下 lookupConstraint 只返回摘要，这里不会命中 —— 判定结果一字不变。
  if (constraint && (constraint.verdict === 'hold' || constraint.verdict === 'ask-evidence')) {
    const reason = constraint.verdict === 'hold' ? 'negative-constraint-hold' : 'negative-constraint-needs-evidence'
    const gateDetail = {
      sessionId,
      question: String(first.question ?? ''),
      constraintVerdict: constraint.verdict,
      constraintReason: constraint.reason,
      ruleId: constraint.rule?.id ?? null,
      requiredEvidence: (constraint.requiredEvidence ?? []).slice(0, 3),
    }
    recordShadowSafe(constraint, 'human')
    appendDecision({ ...gateDetail, outcome: 'human', reason, at: nowIso(clock()) })
    return { kind: 'human', reason, detail: gateDetail }
  }

  const tiers = classifyTiers(options)

  const state = {
    question: String(first.question ?? ''),
    context: sanitizeContext(first.context),
    checkpoint_id: first.checkpoint_id ?? first.step ?? null,
    header: first.header === undefined ? null : String(first.header),
    detail: first.detail === undefined ? null : String(first.detail),
    options: labels,
    session_id: sessionId ?? null,
    // 是非题路径必须把「问的是哪一档」写进 state —— 模型只看得见 state。
    forward_option: tiers ? String(tiers.forward.label) : null,
    fallback_option: tiers ? String(tiers.fallback.label) : null,
  }

  const criteria = {}
  for (const option of options) {
    const label = String(option.label)
    const detail = option.detail || option.description
    criteria[label] = detail ? `${label}：${detail}` : `Select this option: ${label}`
  }

  const profile = loadJudgmentProfile(CONFIG.judgmentProject)
  const qualityCriteria = Array.isArray(profile.quality)
    ? profile.quality
    : Object.keys(profile.quality || { blocked: 1, partial: 2, ready: 3 })
  const noulCommon = {
    // CODEX: Every project judgment loads noul + score + choice together; selection still follows project policy.
    completion: {
      type: 'noul',
      instructions: profile.completion,
    },
    blocked: {
      type: 'noul',
      instructions: profile.blocked,
    },
    quality: {
      type: 'score',
      instructions: 'Score the evidence and safety of the next reply using the project legend.',
      criteria: qualityCriteria,
    },
    pick: {
      type: 'choice',
      instructions: 'Choose the single option in the criteria that best advances the project safely. '
        + 'Use the evidence in context; do not choose by label position.',
      criteria,
    },
    unsure: {
      type: 'noul',
      instructions: 'The question in `question` is genuinely ambiguous, or none of the options in `options` '
        + 'is a defensible answer to it on the evidence given.',
    },
    irreversible: {
      type: 'noul',
      instructions: 'Answering this question commits an irreversible action, a credential or identity check, '
        + 'or a real fund transfer. Superficial wording does not decide it; the consequence does.',
    },
  }

  const questionsSpec = tiers
    ? {
        forward: {
          type: 'noul',
          instructions: 'There is no blocking reason to take the RECOMMENDED forward action in `forward_option` '
            + 'right now: no missing precondition, no unresolved contradiction, and no risk that makes the '
            + 'conservative fallback in `fallback_option` clearly preferable. Judge only on the evidence in '
            + '`context`. Do not answer true merely because the option is labelled recommended, and do not '
            + 'answer false merely because the fallback sounds safer.',
        },
        ...noulCommon,
      }
    : { ...noulCommon }

  const raw = await askJudge(state, questionsSpec)
  if (raw === null) return { kind: 'human', reason: 'judge-unavailable' }

  const answers = raw.answers ?? {}
  const irreversible = Number(answers.irreversible?.noul)
  const unsure = Number(answers.unsure?.noul)
  const completion = Number(answers.completion?.noul)
  const blocked = Number(answers.blocked?.noul)
  const qualityScore = answers.quality?.score ?? null
  const usage = normalizeJudgeUsage(raw.usage)

  const high = CONFIG.approveThreshold
  const low = 1 - CONFIG.approveThreshold

  const forwardProbability = Number(answers.forward?.noul)
  let picked = null
  let pickedProbability = null
  let bandReason = null

  if (tiers) {
    if (!Number.isFinite(forwardProbability)) {
      bandReason = 'noul-missing'
    } else if (forwardProbability >= high) {
      picked = String(tiers.forward.label)
      pickedProbability = forwardProbability
    } else if (forwardProbability <= low) {
      bandReason = 'blocked'
    } else {
      picked = String(tiers.fallback.label)
      pickedProbability = 1 - forwardProbability
    }
  } else {
    picked = answers.pick?.choice
    pickedProbability = Number(answers.pick?.probabilities?.[picked])
  }

  const detail = {
    sessionId,
    checkpointId: state.checkpoint_id,
    question: state.question,
    contextChars: state.context ? state.context.length : 0,
    options: labels,
    tierPath: tiers ? 'noul' : 'choice',
    forwardOption: tiers ? String(tiers.forward.label) : null,
    forwardProbability: Number.isFinite(forwardProbability) ? forwardProbability : null,
    picked: picked ?? null,
    pickedProbability: Number.isFinite(pickedProbability) ? pickedProbability : null,
    irreversible: Number.isFinite(irreversible) ? irreversible : null,
    unsure: Number.isFinite(unsure) ? unsure : null,
    completion: Number.isFinite(completion) ? completion : null,
    blocked: Number.isFinite(blocked) ? blocked : null,
    qualityScore,
    judgeUsage: usage,
    // 约束回流门留痕：影子期用于对账，准入期用于追责（这条判定是被哪条约束影响的）
    constraintGate: constraint
      ? {
          verdict: constraint.verdict ?? 'allow',
          reason: constraint.reason ?? null,
          ruleId: constraint.rule?.id ?? constraint.ruleId ?? null,
          requiredEvidence: (constraint.requiredEvidence ?? []).slice(0, 2),
        }
      : null,
    at: nowIso(clock()),
  }

  recordShadowSafe(constraint, 'no-decision')

  if (Number.isFinite(irreversible) && irreversible >= high) {
    appendDecision({ ...detail, outcome: 'human', reason: 'judge-irreversible' })
    return { kind: 'human', reason: 'judge-irreversible', detail }
  }
  if (Number.isFinite(unsure) && unsure >= high) {
    appendDecision({ ...detail, outcome: 'human', reason: 'judge-unsure' })
    return { kind: 'human', reason: 'judge-unsure', detail }
  }
  if (Number.isFinite(blocked) && blocked >= high) {
    appendDecision({ ...detail, outcome: 'human', reason: 'judge-blocked' })
    return { kind: 'human', reason: 'judge-blocked', detail }
  }
  if (bandReason !== null) {
    appendDecision({ ...detail, outcome: 'human', reason: bandReason })
    return { kind: 'human', reason: bandReason, detail }
  }
  if (picked === undefined || picked === null || !labels.includes(picked)) {
    appendDecision({ ...detail, outcome: 'human', reason: 'judge-undecided' })
    return { kind: 'human', reason: 'judge-undecided', detail }
  }
  if (!tiers && (!Number.isFinite(pickedProbability) || pickedProbability < high)) {
    appendDecision({ ...detail, outcome: 'human', reason: 'below-threshold' })
    return { kind: 'human', reason: 'below-threshold', detail }
  }

  appendDecision({ ...detail, outcome: 'answered', reason: 'auto' })
  return {
    kind: 'answer',
    reason: 'auto',
    detail,
    answer: { answers: [{ id: String(first.id), selected: [picked] }] },
  }
}

// CODEX: Completion is verified by project-defined noul + score + choice, never by a marker alone.
/**
 * 会话最初的原始任务 = 判定「做完」的唯一靶子。
 * 取**第一条非值守注入**的用户消息；值守自己的续跑/代答消息以标记开头，必须排除，
 * 否则评估人格会把「自动续跑」当成 the operator 新下的任务。
 */
function originalTaskOf(events) {
  const list = Array.isArray(events) ? events : []
  for (const event of list) {
    if (event?.type !== 'user/message') continue
    const blocks = event?.data?.message?.content
    const text = Array.isArray(blocks)
      ? blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n')
      : ''
    const trimmed = text.trim()
    if (!trimmed) continue
    if (trimmed.startsWith(AUTO_REPLY_PREFIX) || trimmed.startsWith(AUTO_CONTINUE_PREFIX)) continue
    return trimmed
  }
  return null
}

/**
 * 评估人格出口（三轴：完成 / 可用水准 / 完全合规）。
 * `hooks.evaluate` 是测试替身；生产走 evaluator.js 的真 judge。
 * 评估失败**不放行**（fail-closed），由调用方决定是交人还是继续跑。
 */
function runEvaluator({ task, completionClaim, evidence, sessionId }) {
  if (typeof hooks.evaluate === 'function') {
    return Promise.resolve(hooks.evaluate({ task, completionClaim, evidence, sessionId }))
  }
  return evaluateSession(askJudge, { task, completionClaim, evidence, sessionId })
}

/** 旧判据（三条件概率）→ 统一成评估人格的结果形状，供 `evaluator: false` 降级时使用。 */
function legacyCompletionVerdict(verified) {
  if (verified?.complete) {
    return { done: true, verdict: 'complete', reason: verified.reason ?? 'completion-evidence-confirmed' }
  }
  const reason = verified?.reason ?? 'completion-not-proven'
  return {
    done: false,
    verdict: reason === 'judge-unavailable' ? 'indeterminate' : 'incomplete',
    reason,
  }
}

async function judgeCompletion(text, sessionId) {
  const profile = loadJudgmentProfile(CONFIG.judgmentProject)
  const state = {
    project: CONFIG.judgmentProject,
    session_id: sessionId,
    completion_claim: sanitizeContext(text),
  }
  const criteria = {
    accept_complete: 'The completion claim and its evidence satisfy the project definition of done.',
    continue_work: 'Required implementation, testing, runtime, or evidence remains.',
    human_review: 'The claim depends on a human-only fact or safety-red-line action.',
  }
  const qualityCriteria = Array.isArray(profile.quality)
    ? profile.quality
    : Object.keys(profile.quality || { blocked: 1, partial: 2, ready: 3 })
  const raw = await askJudge(state, {
    completion: { type: 'noul', instructions: profile.completion },
    blocked: { type: 'noul', instructions: profile.blocked },
    quality: { type: 'score', instructions: 'Score completion evidence using the project criteria.', criteria: qualityCriteria },
    pick: { type: 'choice', instructions: 'Choose the correct disposition for this completion claim.', criteria },
  })
  if (!raw) return { complete: false, reason: 'judge-unavailable', detail: null }
  const answers = raw.answers ?? {}
  const probability = Number(answers.completion?.noul)
  const choice = answers.pick?.choice ?? null
  const score = answers.quality?.score ?? null
  const blocked = Number(answers.blocked?.noul)
  const detail = { probability, choice, score, blocked, judgeUsage: normalizeJudgeUsage(raw.usage) }
  if (detail.judgeUsage) accountJudgeUsage(sessionId, detail.judgeUsage, { now: clock() })
  const isScoreReady = score === 'ready' || (typeof score === 'number' && score >= 1.5)
    || answers.quality?.legend?.[String(Math.round(score))] === 'ready'
  const complete = Number.isFinite(probability) && probability >= CONFIG.approveThreshold
    && choice === 'accept_complete' && isScoreReady
  appendDecision({ sessionId, outcome: complete ? 'completion-confirmed' : 'completion-rejected', ...detail, at: nowIso(clock()) })
  return { complete, reason: complete ? 'completion-evidence-confirmed' : 'completion-not-proven', detail }
}

// ---------------------------------------------------------------- 决策卡解析

/** 从模型输出的 Markdown 正文解析三元决策卡片 [DECISION_POINT] / 【决策点】（JSON / 表格 / 序号列表）。 */
export function hasExplicitHumanReview(text) {
  const withoutExamples = String(text || '').replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '')
  for (const match of withoutExamples.matchAll(/\[DECISION_POINT\]\s*(\{[\s\S]*?\})\s*\[\/DECISION_POINT\]/g)) {
    try { const card = JSON.parse(match[1]); if (card.requires_user_response === true || card.audience === 'human' && card.requires_user_response !== false) return true } catch {}
  }
  return false
}

export function parseDecisionPoint(content) {
  if (!content || typeof content !== 'string') return null
  const marks = ['[DECISION_POINT]', '【决策点】', '[决策点]']
  let pointIdx = -1
  for (const mark of marks) {
    const idx = content.indexOf(mark)
    if (idx !== -1 && (pointIdx === -1 || idx < pointIdx)) {
      pointIdx = idx
    }
  }
  if (pointIdx === -1) return null
  const part = content.slice(pointIdx)
  const prefix = content.slice(0, pointIdx).trim()

  const jsonMatch = part.match(
    /(?:\[DECISION_POINT\]|【决策点】|\[决策点\])\s*(?:```(?:json)?\s*)?(\{[\s\S]*?\})\s*(?:```\s*)?(?:\[\/DECISION_POINT\]|【\/决策点】|\[\/决策点\]|$)/i,
  )
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      if (Array.isArray(parsed.options) && parsed.options.length > 0) {
        return {
          id: parsed.checkpoint_id || 'decision_point',
          checkpoint_id: parsed.checkpoint_id || null,
          audience: parsed.audience || 'watch',
          requires_user_response: parsed.requires_user_response === true,
          context: parsed.context || prefix.slice(-300) || null,
          question: parsed.question || '请确认下一步决策',
          options: parsed.options.map((opt, i) => {
            const label = typeof opt === 'string' ? opt : (opt.label || opt.text || String(opt))
            return {
              id: String(i + 1),
              label: label.trim(),
              detail: typeof opt === 'object' && opt.detail ? String(opt.detail).trim() : undefined,
            }
          }),
        }
      }
    } catch { /* 不是合法 JSON，继续尝试 Markdown 表格 */ }
  }

  const lines = part.split('\n')
  const tableRows = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length >= 2) {
      const HEADERS = ['选项', '档', '档位', '级别', '方案', '动作']
      if (HEADERS.includes(cells[0]) || HEADERS.includes(cells[1])
        || cells.every((c) => /^[-:]+$/.test(c))) continue
      let label = ''
      let detail = ''
      // 首格是档位标记（① / ① (Recommended) / 1. / **(Recommended)**）时，**标签取第二格的动作文本**：
      // 2026-10-11 实测踩坑 —— 旧的严格匹配只认「①」这种纯标记，写成「① (Recommended)」整格就被当成标签，
      // 于是选项被解析成 ["档","① (Recommended)","② 容错·降级"]，动作全丢，值守据此选了「档」这个表头。
      // 判据：**三列及以上的表**里，首格以圈码/序号开头就算「档位列」（`① (Recommended)` / `② 容错·降级` 都算），
      // 动作取第二格；两列表保持旧行为（首格当标签），避免把 `| ① 做 A | 说明 |` 这种写法读反。
      const isTier = (cells.length >= 3
        && /^\*{0,2}(?:[①②③④⑤]|\d+[.)])\s*(?:\((?:[Rr]ecommended|推荐)\))?/.test(cells[0]))
        || /^\*{0,2}\((?:[Rr]ecommended|推荐)\)\*{0,2}$/.test(cells[0])
      if (isTier) {
        label = cells[1] || ''
        detail = cells.slice(2).join(' | ')
        const tier = cells[0].replace(/\*\*/g, '').trim()
        if (tier) detail = detail ? `${tier}｜${detail}` : tier
      } else {
        label = cells[0]
        detail = cells.slice(1).join(' | ')
      }
      label = label.replace(/^\*\*|\*\*$/g, '').trim()
      if (label) tableRows.push({ id: String(tableRows.length + 1), label, detail: detail || undefined })
    }
  }

  if (tableRows.length > 0) {
    const cleanPrefix = prefix.replace(/^#+\s+/gm, '').trim()
    const paragraphs = cleanPrefix
      .split('\n\n')
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith('产物：') && !p.startsWith('产物:'))
    const contextText = paragraphs.slice(-2).join('\n\n') || cleanPrefix.slice(-400)
    return {
      id: 'decision_point',
      checkpoint_id: null,
      context: contextText.slice(0, 400) || null,
      question: '请确认下一步决策',
      options: tableRows,
    }
  }

  const listRows = []
  for (const line of lines) {
    const trimmed = line.trim()
    const listMatch = trimmed.match(/^(?:[-*+]\s+)?(?:[①②③④⑤]|\d+[.)])\s*(.*)$/)
    if (listMatch) {
      let raw = listMatch[1].trim()
      raw = raw.replace(/^\*\*|\*\*$/g, '').trim()
      if (raw) listRows.push({ id: String(listRows.length + 1), label: raw })
    }
  }
  if (listRows.length >= 2) {
    return {
      id: 'decision_point',
      checkpoint_id: null,
      context: null,
      question: '请确认下一步决策',
      options: listRows,
    }
  }

  return null
}

let CONFIG = { ...Config }
/** 界面半最近一次自检上报；用于不靠截图判断开关是否真的挂上。 */
let lastBeacon = null
/** 会话最近一次助手输出文本（内存加速；冷会话回退到持久化只读）。 */
const lastAssistantMessageBySession = new Map()
/** 进程内并发闸：同一会话同一时刻只跑一次自驱动（跨进程靠决策锁）。 */
const inFlightBySession = new Set()
/** 最近的运行细节（比租约更细，用于界面显示与排查；不参与恢复）。 */
const runtimeDetailBySession = new Map()
/** 会话可用性缓存（list() 较贵，60 秒一次足够判断「不存在/已归档」）。 */
let sessionIndexCache = { at: 0, ids: null, error: null }
/** 界面实例标识（多实例并发时用于区分持有者）。 */
const INSTANCE = instanceId()

function updateRuntimeDetail(sessionId, patch) {
  const key = String(sessionId ?? '')
  if (!key) return
  runtimeDetailBySession.set(key, {
    ...(runtimeDetailBySession.get(key) ?? {}),
    ...patch,
    updatedAt: nowIso(clock()),
  })
}

function detailOf(sessionId) {
  return runtimeDetailBySession.get(String(sessionId ?? '')) ?? {}
}

/**
 * 把上游错误压成可追的一条字符串。
 *
 * DSH 的 RemoteError 把真因放在 `details.reason` 里：实测 `session/agent-busy`
 * + `prompt rejected` 的真实原因其实是 `agent "…" lifecycle disposed`。
 */
export function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  const code = error.code ?? error.name ?? null
  const details = error.details ?? error.data ?? null
  let detailText = ''
  try {
    if (details !== null && details !== undefined) {
      detailText = typeof details === 'string' ? details : JSON.stringify(details)
    }
  } catch { detailText = '[unserializable details]' }
  const message = error.message ?? String(error)
  return redact([code ? `[${code}]` : null, message, detailText || null].filter(Boolean).join(' '), 400)
}

function liveAgentOf(value) {
  if (!value) return null
  if (value.agent) return value.agent
  if (typeof value.followup === 'function') return value
  return null
}

/**
 * 将决策结果注入会话（两步走，顺序不能反）。
 *
 *   1) **先激活**：冷会话没有 live agent loop，直接投递会被 `session/agent-busy` 拒；
 *      `sessionController.resolveAgent()` 的语义正是「resolve or resume」。
 *   2) **再投递**：优先 SessionController.prompt；抛错则退避到 live agent 的 followup。
 */
export async function promptSession(ctx, sessionId, text) {
  if (disposedContexts.has(ctx)) throw new Error('context-disposed: refusing stale delivery')
  if (hooks.prompt) {
    const result = await hooks.prompt(ctx, sessionId, text)
    return { accepted: true, via: 'test-hook', ...(result ?? {}) }
  }
  if (faultHit('send-fail-once') || faultHit('send-fail-always')) {
    throw new Error('[injected] session/agent-busy prompt rejected (details.reason: agent lifecycle disposed)')
  }
  if (disposedContexts.has(ctx)) throw new Error('context-disposed: refusing stale delivery')
  const sessionController = optionalSessionController(ctx)
  const agents = runtimeService(ctx, 'agents')
  const content = [{ type: 'text', text }]

  if (sessionController && typeof sessionController.resolveAgent === 'function') {
    try {
      const resolved = await sessionController.resolveAgent(sessionId)
      if (resolved && resolved.error) throw new Error(describeError(resolved.error))
      log({ type: 'prompt-activate', sessionId, activated: liveAgentOf(resolved) !== null })
    } catch (error) {
      throw new Error(`activate failed for ${sessionId}: ${describeError(error)}`)
    }
  }

  let promptFailure = null
  if (sessionController && typeof sessionController.prompt === 'function') {
    try {
      const raw = await sessionController.prompt({ requestId: `jev-${fingerprintOf(sessionId, text)}`, sessionId, content, mode: 'queue' }, new AbortController().signal)
      return { accepted: true, via: 'sessionController.prompt', raw: summarize(JSON.stringify(raw ?? {}), 200) }
    } catch (error) {
      promptFailure = error
      log({ type: 'prompt-rejected', sessionId, detail: describeError(error) })
    }
  }

  const agent = liveAgentOf(agents?.get?.(sessionId))
  if (agent && typeof agent.followup === 'function') {
    try {
      agent.followup({
        id: (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `msg-${Date.now()}`),
        role: 'user',
        content,
        source: { kind: 'user' },
      })
      return { accepted: true, via: 'agent.followup', after: promptFailure ? describeError(promptFailure) : null }
    } catch (error) {
      throw new Error(
        `prompt failed for ${sessionId}: ${describeError(promptFailure)} | followup failed: ${describeError(error)}`,
      )
    }
  }

  if (promptFailure) throw new Error(`prompt failed for ${sessionId}: ${describeError(promptFailure)}`)
  throw new Error(`Neither sessionController nor agent available for session ${sessionId}`)
}

// ---------------------------------------------------------------- 会话只读读取

function latestAssistantTextFromEvents(events) {
  const list = Array.isArray(events) ? events : []
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i]
    if (ev.type === 'user/message') return null
    if (ev.type === 'assistant/message') {
      const textBlocks = ev.data?.message?.content?.filter?.((b) => b.type === 'text')?.map?.((b) => b.text) || []
      if (textBlocks.length > 0) return textBlocks.join('\n')
    }
  }
  return null
}

/** 会话是否「不存在/已归档」：inspect 失败后按 list() 判定（带缓存）。 */
async function sessionIndexHas(ctx, sessionId) {
  const now = clock()
  if (!sessionIndexCache.ids || now - sessionIndexCache.at > 60_000) {
    const sessionController = optionalSessionController(ctx)
    if (sessionController && typeof sessionController.list === 'function') {
      try {
        const listed = await sessionController.list({}, new AbortController().signal)
        const items = Array.isArray(listed?.items) ? listed.items : []
        sessionIndexCache = { at: now, ids: new Set(items.map((item) => String(item?.sessionId ?? ''))), error: null }
      } catch (error) {
        sessionIndexCache = { at: now, ids: sessionIndexCache.ids, error: describeError(error) }
      }
    } else {
      sessionIndexCache = { at: now, ids: null, error: 'list-unavailable' }
    }
  }
  if (!sessionIndexCache.ids) return null
  return sessionIndexCache.ids.has(String(sessionId))
}

/**
 * 只读读取会话快照：正文、事件、token 用量、是否还存在。
 * 冷会话走 `sessionController.inspect()` —— 不激活 Agent、不触发新回合、不抢焦点。
 */
export async function readSessionSnapshot(ctx, sessionId) {
  const session = runtimeService(ctx, 'sessions')?.get?.(sessionId)
  if (session && typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    return {
      exists: true,
      source: 'live',
      events,
      text: lastAssistantMessageBySession.get(sessionId) ?? latestAssistantTextFromEvents(events),
      usage: foldSessionUsage(events),
      error: null,
      running: true,
    }
  }

  const sessionController = optionalSessionController(ctx)
  if (sessionController && typeof sessionController.inspect === 'function') {
    try {
      const inspected = await sessionController.inspect(sessionId, new AbortController().signal)
      const events = inspected?.events ?? []
      return {
        exists: true,
        source: 'inspect',
        events,
        text: latestAssistantTextFromEvents(events),
        usage: foldSessionUsage(events),
        error: null,
        running: false,
      }
    } catch (error) {
      const detail = describeError(error)
      const known = await sessionIndexHas(ctx, sessionId)
      return {
        exists: false,
        source: 'inspect',
        events: [],
        text: null,
        usage: null,
        error: detail,
        missing: known === false,
        running: false,
      }
    }
  }
  return { exists: false, source: 'none', events: [], text: null, usage: null, error: 'no-session-reader', running: false }
}

/** 兼容旧导出：只要正文。 */
export async function getLatestAssistantText(ctx, sessionId) {
  if (lastAssistantMessageBySession.has(sessionId)) return lastAssistantMessageBySession.get(sessionId)
  const snapshot = await readSessionSnapshot(ctx, sessionId)
  return snapshot.text
}

// ---------------------------------------------------------------- 事务管线

/** 把结果写进租约 + 运行细节（一个动作一处落点，避免状态分叉）。 */
function settle(sessionId, { phase, reason, stopReason = null, extra = {} }) {
  const patch = { phase, reason, ...extra }
  if (stopReason) patch.stopReason = stopReason
  updateRuntimeDetail(sessionId, { phase, reason, reasonLabel: reasonText(reason), ...extra })
  patchLease(sessionId, patch, { now: clock(), history: { event: phase, note: reason } })
  return { ok: false, reason, phase }
}

/**
 * 构造自主续跑的投递正文。**必须自证来源**：消息会以用户身份落进会话，
 * 下一次读回时不能让它被误认成 the operator 的新指令或新增授权。
 *
 * `evaluation`（可选）：带上评估人格给的方向与分数，让续跑变成**定向改进**，
 * 而不是空喊一句「继续」——不达 9 分时要说清差在哪。
 */
function buildAutoContinueText(evaluation = null) {
  const lines = [
    AUTO_CONTINUE_PREFIX + ' This is not a message from the user, not a new instruction, and not a new grant of authority.',
    '',
    '按本会话一开始的原始任务继续执行下一步，不要停下来问「要不要继续」。',
  ]
  if (evaluation?.verdict === 'incomplete') {
    lines.push(
      '',
      '评估人格判定：任务尚未完成（质量与合规由项目既有门禁把关）。',
      '',
      '- ① 按判据补齐缺的那一层证据（读回数值 / 命令输出 / 平台读数），别只增加说明文字。',
      '- ② 补完自己重跑一遍验证，把读回证据留在会话里。',
      '- ③ 证据齐了再声明完成；没齐就继续补，不要停下来等 the operator。',
    )
  } else {
    lines.push(
      '',
      '- ① 有把握的动作直接做，做完回平台读回证据；要留痕。',
      '- ② 真过不去（人工控件 / 资金动作 / 登录 / 合规红线）才停下，并把卡点写清楚。',
      '- ③ 全部做完、且质量达标（10 分制 ≥ 9）时，按完成串格式收尾：任务状态：已 100% 完成 —— <做完了什么> · 判据：<证据>。',
    )
  }
  return lines.join('\n')
}

/** 自动提交到会话的可见来源标记。 */

/**
 * 自主续跑：注入一轮「继续执行」（唯一实现，两个触发点共用）。
 *
 * 为什么要共用：判断卡是不是停车问句（judge 的 `continue` 分支）与
 * 「一轮结束但什么都没产出」（无决策卡分支）是同一个动作 —— 续跑一次。
 * 两处各写一遍就会漂移，故只留这里。
 *
 * 护栏（缺一不可，均已带留痕）：
 *   · 同一段正文只续一次（指纹去重）—— 模型原地打转时不再推，避免烧 token 的死循环；
 *   · 单条租约累计上限 maxAutoContinues —— 到顶即停并写 auto-continue-held，不静默。
 */
async function continueSession(ctx, key, text, triggerSource, reason, evaluation = null) {
  if (CONFIG.autoContinue !== true) return null
  const lease = getLease(key)
  const fingerprint = fingerprintOf(key, normalizeText(text ?? ''))
  if (lease?.continueFromFingerprint === fingerprint) {
    // 同一段正文又出现：**先别判卡住**。正文没变最常见的不是「它卡住了」，
    // 而是「它这一轮还没跑完」（没有 turn/end，快照读到的仍是上一轮）。
    // 所以先冷却重试，只有连着看到同一段达到阈值，才认「真推不动」并交人。
    const repeats = (Number(lease?.continueSameTextCount) || 0) + 1
    const stallAfter = Number.isFinite(Number(CONFIG.autoContinueStallAfter)) ? Number(CONFIG.autoContinueStallAfter) : 3
    if (repeats >= stallAfter) {
      appendDecision({
        sessionId: key,
        outcome: 'auto-continue-stall',
        reason: 'auto-continue-same-turn',
        repeats,
        triggerSource,
        ...complianceTrace(text),
        at: nowIso(clock()),
      })
      return settle(key, { phase: 'needs-human', reason: 'auto-continue-stall', stopReason: 'auto-continue-stall' })
    }
    const cooldownMs = Number.isFinite(Number(CONFIG.autoContinueCooldownMs)) ? Number(CONFIG.autoContinueCooldownMs) : 30 * 60 * 1000
    // 冷却窗口用「短窗」：等它自己把这一轮跑完，再回来看正文有没有变。
    const waitMs = Math.max(60_000, Math.min(cooldownMs, 5 * 60 * 1000))
    patchLease(key, {
      continueSameTextCount: repeats,
      autoContinueCooldownUntil: new Date(clock() + waitMs).toISOString(),
    }, { now: clock(), touchActivity: false })
    return settle(key, {
      phase: 'observing',
      reason: 'auto-continue-waiting-for-turn',
      extra: { continueSameTextCount: repeats },
    })
  }
  // 正文变了 → 不是打转，清掉同段计数。
  if (Number(lease?.continueSameTextCount) > 0) {
    patchLease(key, { continueSameTextCount: 0 }, { now: clock(), touchActivity: false })
  }
  const used = Number(lease?.autoContinueCount) || 0
  const cap = Number.isFinite(Number(CONFIG.maxAutoContinues)) ? Number(CONFIG.maxAutoContinues) : 40
  const cooldownMs = Number.isFinite(Number(CONFIG.autoContinueCooldownMs))
    ? Number(CONFIG.autoContinueCooldownMs)
    : 30 * 60 * 1000
  const cooldownUntilMs = lease?.autoContinueCooldownUntil ? Date.parse(lease.autoContinueCooldownUntil) : null
  const cooling = cooldownUntilMs !== null && Number.isFinite(cooldownUntilMs) && cooldownUntilMs > clock()

  // 同段等待窗内不动手：让它把当前这一轮跑完（这是「正文没变」的最常见原因）。
  if (cooling && (Number(lease?.continueSameTextCount) || 0) > 0) {
    return settle(key, { phase: 'observing', reason: 'auto-continue-waiting-for-turn' })
  }

  if (used >= cap && cooling) {
    return settle(key, {
      phase: 'observing',
      reason: 'auto-continue-cooling',
      extra: { autoContinueCooldownUntil: lease.autoContinueCooldownUntil },
    })
  }
  // 冷却到期 → 开新的一段（计数归零、清掉冷却标记），继续跑。
  const run = used >= cap ? 0 : used
  if (used >= cap) {
    appendDecision({
      sessionId: key,
      outcome: 'auto-continue-resumed',
      reason: 'auto-continue-cooldown-elapsed',
      previousRuns: used,
      triggerSource,
      at: nowIso(clock()),
    })
    patchLease(key, { autoContinueCount: 0, autoContinueCooldownUntil: null }, { now: clock(), touchActivity: false })
  }

  updateRuntimeDetail(key, { phase: 'continuing', reason })
  patchLease(key, { phase: 'continuing', reason }, { now: clock(), touchActivity: false })
  try {
    const sent = await promptSession(ctx, key, buildAutoContinueText(evaluation))
    const nextCount = run + 1
    patchLease(key, {
      phase: 'observing',
      reason,
      continueFromFingerprint: fingerprint,
      autoContinueCount: nextCount,
      autoContinueAt: nowIso(clock()),
      // 跑满这一段就挂上冷却时间点：到期自动开新一段，继续跑（不是终止）。
      ...(nextCount >= cap ? { autoContinueCooldownUntil: new Date(clock() + cooldownMs).toISOString() } : {}),
    }, { now: clock(), history: { event: 'auto-continue', note: reason } })
    appendDecision({
      sessionId: key,
      outcome: 'auto-continue-sent',
      reason,
      triggerSource,
      round: nextCount,
      via: sent?.via ?? null,
      at: nowIso(clock()),
    })
    return { ok: true, phase: 'continuing', reason, continued: true }
  } catch (error) {
    log({ type: 'auto-continue-failed', sessionId: key, reason, detail: describeError(error) })
    appendDecision({
      sessionId: key,
      outcome: 'auto-continue-failed',
      reason,
      detail: describeError(error),
      at: nowIso(clock()),
    })
    return settle(key, { phase: 'observing', reason: 'auto-continue-failed' })
  }
}

/** ctx 只在本进程内用于续跑投递（与 autoDriveSession 的 ctx 同一处，避免穿参）。 */
let ctxForContinueLast = null

/**
 * 单次推进：这是唯一会「判断 + 发送」的入口。
 *
 * 顺序即安全边界（改动前先读这段）：
 *   租约闸门 → 全局控制面闸门 → 读会话 → 现有操作记录（committed 短路 / needs-human 短路）
 *   → 需判断则取跨进程决策锁后判断 → 发送前再查全局闸门与租约 → 校验卡片仍是最新
 *   → 发送前置读回（防「回执丢失」重复发送）→ 落 sending → 投递 → 回执 → committed。
 */
export async function autoDriveSession(ctx, sessionId, triggerSource = 'event') {
  if (disposedContexts.has(ctx)) return { ok: false, reason: 'context-disposed' }
  const now = clock()
  const key = String(sessionId ?? '')
  if (!key) return { ok: false, reason: 'no-session' }

  // ── 1. 租约闸门：到期 / 轮数上限 / 预算耗尽都在这里停手 ──
  const lease = getLease(key)
  const verdict = leaseVerdict(lease, now)
  if (!verdict.allowed) {
    return settle(key, { phase: verdict.phase, reason: verdict.reason, stopReason: verdict.reason })
  }

  // ── 2. 全局控制面闸门：stop 全停，takeover 只读 ──
  const gate = globalGate()
  if (!gate.allowed) {
    return settle(key, { phase: gate.phase, reason: gate.reason, stopReason: gate.reason })
  }

  // ── 3. 进程内并发闸 ──
  if (inFlightBySession.has(key)) return { ok: false, reason: 'judging-in-flight' }
  inFlightBySession.add(key)
  updateRuntimeDetail(key, { triggerSource, phase: 'checking' })
  patchLease(key, { phase: 'checking', triggerSource, reason: null }, { now: clock(), touchActivity: false })
  try {
    // ── 4. 只读会话 ──
    const snapshot = await readSessionSnapshot(ctx, key)
    if (!snapshot.exists) {
      const reason = snapshot.missing === false ? 'session-unavailable' : 'session-missing'
      log({ type: 'session-unavailable', sessionId: key, detail: snapshot.error, missing: snapshot.missing })
      return settle(key, { phase: 'session-missing', reason, stopReason: reason })
    }

    // token 台账：每次都读回真实用量，缓存读与未缓存输入分列记账。
    if (snapshot.usage) {
      accountDshUsage(key, snapshot.usage, { now: clock() })
      attributePendingUsage(key, snapshot.usage)
    }

    const text = snapshot.text
    if (hasExplicitHumanReview(text)) return settle(key, { phase: 'needs-human', reason: 'explicit-human-question', stopReason: 'explicit-human-question' })
    const completion = completionEvidence(text)
    if (completion.complete) {
      // 完成由**评估人格**裁：完成轴 + 质量轴（10 分制，9 分线）+ 合规轴，三条同时成立才算完成。
      // 不够 9 分 = 任务没完成 → 不在这里停，继续想办法（the operator 2026-10-12 定）。
      const evaluation = CONFIG.evaluator === false
        ? legacyCompletionVerdict(await judgeCompletion(text, key))
        : await runEvaluator({
            task: originalTaskOf(snapshot.events),
            completionClaim: text,
            evidence: null,
            sessionId: key,
          })

      if (evaluation.verdict === 'violation' || evaluation.verdict === 'indeterminate') {
        appendDecision({
          sessionId: key,
          outcome: 'evaluation-blocked',
          verdict: evaluation.verdict,
          reason: evaluation.reason,
          quality: evaluation.quality ?? null,
          ...complianceTrace(text),
          at: nowIso(clock()),
        })
        return settle(key, { phase: 'needs-human', reason: evaluation.reason, stopReason: evaluation.reason })
      }

      if (!evaluation.done) {
        // 没做完 / 不到 9 分 → 把「差在哪」当续跑指令，继续想办法，不在收尾停手。
        const continued = await continueSession(
          ctx, key, text, triggerSource,
          evaluation.reason ?? 'evaluation-incomplete',
          evaluation,
        )
        return continued ?? settle(key, { phase: 'observing', reason: evaluation.reason ?? 'evaluation-incomplete' })
      }

      const verified = { complete: true, reason: evaluation.reason }
      patchLease(key, {
        phase: 'session-complete',
        reason: verified.reason,
        stopReason: null,
        completedAt: nowIso(clock()),
      }, { now: clock(), touchActivity: false, history: { event: 'session-complete', note: verified.reason } })
      updateRuntimeDetail(key, { phase: 'session-complete', reason: verified.reason })
      appendDecision({ sessionId: key, outcome: 'session-complete', reason: verified.reason, ...complianceTrace(text), at: nowIso(clock()) })
      return { ok: true, complete: true, phase: 'session-complete', reason: verified.reason }
    }
    if (!text || !text.includes('[DECISION_POINT]')) {
      // 没决策卡 ≠ 收工。会话任务只有「完成」才是终点：
      // 判不到完成证据（或没证据可判）就自主续跑，直到完成或撞上真边界。
      const continued = await continueSession(ctx, key, text, triggerSource, 'auto-continue-no-decision')
      return continued ?? settle(key, { phase: 'observing', reason: 'no-decision-point' })
    }

    const card = text.slice(text.indexOf('[DECISION_POINT]')).trim()
    const fingerprint = fingerprintOf(key, normalizeText(card))

    // ── 5. 现有操作记录：已提交 / 已转人工的卡片一律短路（不重复判断、不重复发送）──
    let op = findOp(key, fingerprint)
    if (op?.phase === 'committed') {
      return settle(key, { phase: 'observing', reason: 'already-handled' })
    }
    if (op?.phase === 'needs-human' && getLease(key)?.fallbackEnabled === true && canFallbackReply(op.reason, card)) {
      op = upsertOp({ ...op, phase: 'new', previousHumanReason: op.reason }, { now: clock() })
    }
    if (op && ['needs-human', 'human-answered', 'failed'].includes(op.phase)) {
      return settle(key, {
        phase: 'needs-human',
        reason: op.reason ?? 'needs-human',
        stopReason: op.reason ?? 'needs-human',
      })
    }

    // 卡片内容变了 → 旧记录按「被新版本取代」留痕，不作为已处理
    const previous = latestOp(key)
    if (previous && previous.fingerprint !== fingerprint && !['stale', 'committed'].includes(previous.phase)) {
      markStale(key, previous.fingerprint, { now: clock() })
    }

    // ── 6. 需要判断时：先取跨进程决策锁，再判断 ──
    if (!op || ['new', 'judging'].includes(op.phase)) {
      // 预算预留：已知上一次判断成本且余额不够时，不再调 judge（省钱且避免「判完不能发」）。
      const budgetCheck = budgetGuardForJudge(getLease(key))
      if (!budgetCheck.allowed) {
        return settle(key, { phase: 'budget-exhausted', reason: 'budget-exhausted', stopReason: 'budget-exhausted' })
      }
      const lock = readDecisionLock(key, fingerprint)
      const lockAlive = lock && (!lock.expiresAt || Date.parse(lock.expiresAt) > clock())
      if (lockAlive && lock.instanceId !== INSTANCE) {
        return settle(key, { phase: 'observing', reason: 'locked-by-peer' })
      }
      if (lockAlive && lock.instanceId === INSTANCE && op?.phase === 'judging') {
        return { ok: false, reason: 'judging-in-flight', phase: 'judging' }
      }

      const raw = parseDecisionPoint(text) || (getLease(key)?.fallbackEnabled === true ? { question: card, context: card, options: [] } : null)
      if (!raw || !raw.options || (raw.options.length === 0 && getLease(key)?.fallbackEnabled !== true)) {
        upsertOp({
          sessionId: key,
          fingerprint,
          phase: 'needs-human',
          reason: 'unparseable',
          question: summarize(card, 200),
        }, { now: clock() })
        return settle(key, { phase: 'needs-human', reason: 'unparseable', stopReason: 'unparseable' })
      }

      const { parsed, humanTier } = splitHumanTier(raw)
      if (humanTier) log({ type: 'auto-drive-human-tier-excluded', sessionId: key, label: summarize(humanTier.label, 80) })

      const acquired = acquireDecisionLock({
        sessionId: key, fingerprint, instanceId: INSTANCE, ttlMs: CONFIG.lockTtlMs, now: clock(), phase: 'judging',
      })
      if (!acquired.ok) {
        return settle(key, { phase: 'observing', reason: 'locked-by-peer' })
      }

      let releaseLock = true
      try {
        const base = {
          sessionId: key,
          fingerprint,
          checkpointId: parsed.checkpoint_id ?? null,
          triggerSource,
          question: parsed.question,
          contextChars: sanitizeContext(parsed.context)?.length ?? 0,
          options: parsed.options.map((o) => o.label),
          leaseId: getLease(key)?.leaseId ?? null,
          instanceId: INSTANCE,
          sendAttempts: op?.sendAttempts ?? 0,
          holder: INSTANCE,
          phase: 'judging',
          judgingStartedAt: nowIso(clock()),
        }
        upsertOp(base, { now: clock() })
        updateRuntimeDetail(key, { phase: 'judging' })
        patchLease(key, { phase: 'judging' }, { now: clock(), touchActivity: false })

        const heartbeat = setInterval(() => {
          try {
            touchDecisionLock(key, fingerprint, { instanceId: INSTANCE, ttlMs: CONFIG.lockTtlMs, phase: 'judging' })
          } catch { /* 续租失败不致命 */ }
        }, Math.max(5_000, Math.floor((Number(CONFIG.lockTtlMs) || 120_000) / 3)))
        if (typeof heartbeat.unref === 'function') heartbeat.unref()

        let judgeVerdict
        try {
          log({ type: 'auto-drive-evaluating', sessionId: key, triggerSource, options: parsed.options.map((o) => o.label) })
          judgeVerdict = await judge([parsed], key)
        } finally {
          clearInterval(heartbeat)
        }

        if (disposedContexts.has(ctx)) return { ok: false, reason: 'context-disposed' }

        // 判断期间发生 stop / takeover → 结果不得继续发送（全局停止优先级最高）。
        const afterJudgeGate = globalGate()
        if (!afterJudgeGate.allowed) {
          upsertOp({
            ...base,
            phase: 'decided-blocked',
            blockedBy: afterJudgeGate.phase,
            reason: afterJudgeGate.reason,
            jev: judgeVerdict.detail?.judgeUsage ?? null,
          }, { now: clock() })
          releaseDecisionLock(key, fingerprint, { instanceId: INSTANCE })
          releaseLock = false
          return settle(key, {
            phase: afterJudgeGate.phase, reason: afterJudgeGate.reason, stopReason: afterJudgeGate.reason,
          })
        }

        if (judgeVerdict.detail?.judgeUsage) accountJudgeUsage(key, judgeVerdict.detail.judgeUsage, { now: clock() })

        // 停车问句：模型把卡写成「等你发话才继续」——不是待答问题，直接续跑（the operator 2026-10-12 定）。
        if (judgeVerdict.kind === 'continue') {
          releaseDecisionLock(key, fingerprint, { instanceId: INSTANCE })
          releaseLock = false
          const continued = await continueSession(ctx, key, text, triggerSource, judgeVerdict.reason ?? 'parking-question')
          return continued ?? { ok: false, reason: 'auto-continue-disabled', phase: 'observing' }
        }

        if (judgeVerdict.kind !== 'answer') {
          const lease = getLease(key)
          const hermesOn = lease?.fallbackEnabled === true && lease?.replyProvider !== 'none'
          if (!hermesOn || !canFallbackReply(judgeVerdict.reason, JSON.stringify(parsed))) {
            // 安全红线、真实阻塞等仍是人工终态，绝不让 Provider 绕过。
            upsertOp({
              ...base,
              phase: 'needs-human',
              reason: judgeVerdict.reason,
              jev: judgeVerdict.detail?.judgeUsage ?? null,
              forwardProbability: judgeVerdict.detail?.forwardProbability ?? null,
            }, { now: clock() })
            releaseDecisionLock(key, fingerprint, { instanceId: INSTANCE })
            releaseLock = false
            return settle(key, {
              phase: 'needs-human', reason: judgeVerdict.reason, stopReason: judgeVerdict.reason,
            })
          }

          // CODEX: Ordinary judge uncertainty is handed to a reply provider as a reply-only fallback.
          const picked = '请根据当前问题和证据选择安全、可逆的下一步；信息不足时让 DSH 先补充证据。'
          updateRuntimeDetail(key, { phase: 'replying', replyProvider: 'fallback', fallbackFrom: judgeVerdict.reason })
          patchLease(key, { phase: 'replying', replyProvider: 'fallback' }, { now: clock(), touchActivity: false })
          const generated = await safeProviderReply({ provider: 'fallback', parsed, picked, detail: judgeVerdict.detail, sessionId: key })
          // 质量门（the operator 2026-10-12）：答得糊弄就退回人工，不许把推回型空话当答复投递。
          const quality = checkAnswerQuality(generated?.text)
          if (!quality.ok) {
            log({ type: 'hermes-answer-quality-rejected', sessionId: key, reason: quality.reason, hard: quality.hard })
            upsertOp({
              ...base,
              phase: 'needs-human',
              reason: `answer-quality:${quality.reason}`,
              providerReply: summarize(generated?.text, 200),
              jev: judgeVerdict.detail?.judgeUsage ?? null,
            }, { now: clock() })
            releaseDecisionLock(key, fingerprint, { instanceId: INSTANCE })
            releaseLock = false
            return settle(key, {
              phase: 'needs-human', reason: `answer-quality:${quality.reason}`, stopReason: `answer-quality:${quality.reason}`,
            })
          }
          const submittedText = formatFallbackReply(generated?.text)
          op = upsertOp({
            ...base,
            phase: 'decided',
            picked: 'a reply provider 安全兜底',
            replyProvider: 'fallback',
            providerReply: summarize(generated?.text, 400),
            replyError: generated?.replyError ?? null,
            submittedText,
            reason: `hermes-fallback:${judgeVerdict.reason}`,
            fallbackFrom: judgeVerdict.reason,
            forwardProbability: judgeVerdict.detail?.forwardProbability ?? null,
            jev: judgeVerdict.detail?.judgeUsage ?? null,
            dshUsageBefore: snapshot.usage?.total ?? null,
            decidedAt: nowIso(clock()),
          }, { now: clock() })
          log({ type: 'auto-drive-hermes-fallback', sessionId: key, reason: judgeVerdict.reason })
        } else {
          const picked = judgeVerdict.answer.answers[0].selected[0]
          const enabledProviders = activeProviders(loadToggles())
          const provider = enabledProviders.length
            ? enabledProviders
            : (getLease(key)?.replyProvider ?? CONFIG.defaultReplyProvider)
          updateRuntimeDetail(key, { phase: 'replying', replyProvider: provider })
          patchLease(key, { phase: 'replying', replyProvider: provider }, { now: clock(), touchActivity: false })
          const generated = await safeProviderReply({ provider, parsed, picked, detail: judgeVerdict.detail, sessionId: key, ctx })
          if (Array.isArray(provider) && generated?.fallback) {
            const reason = 'provider-group-unavailable'
            upsertOp({
              ...base,
              phase: 'needs-human',
              reason,
              replyProvider: provider,
              replyError: generated?.replyError ?? '所有已开启 Provider 都没有返回回复',
              jev: judgeVerdict.detail?.judgeUsage ?? null,
            }, { now: clock() })
            releaseDecisionLock(key, fingerprint, { instanceId: INSTANCE })
            releaseLock = false
            return settle(key, { phase: 'needs-human', reason, stopReason: reason })
          }
          const submittedText = formatAutoReply(picked, provider, generated?.text)
          op = upsertOp({
            ...base,
            phase: 'decided',
            picked,
            replyProvider: provider,
            providerReply: summarize(generated?.text, 400),
            replyError: generated?.replyError ?? null,
            submittedText,
            reason: judgeVerdict.reason,
            forwardProbability: judgeVerdict.detail?.forwardProbability ?? null,
            pickedProbability: judgeVerdict.detail?.pickedProbability ?? null,
            jev: judgeVerdict.detail?.judgeUsage ?? null,
            dshUsageBefore: snapshot.usage?.total ?? null,
            decidedAt: nowIso(clock()),
          }, { now: clock() })
          log({ type: 'auto-drive-decided', sessionId: key, picked: summarize(picked, 120) })
        }
        if (faultHit('crash-after-decide')) {
          // 真崩溃（场景 B）：判断结果**已落盘**为 decided，进程当场死。
          // 恢复后应复用这条判断直接发送，而不是再花一次 judge 判断。
          log({ type: 'fault-crash-after-decide', sessionId: key, picked: summarize(op?.picked, 80) })
          process.kill(process.pid, 'SIGKILL')
          return { ok: false, reason: 'crashed' }
        }
      } finally {
        if (releaseLock) releaseDecisionLock(key, fingerprint, { instanceId: INSTANCE })
      }
    }

    // ── 7. 发送路径（只有持锁者能走到这里）──
    if (disposedContexts.has(ctx)) return { ok: false, reason: 'context-disposed' }
    return await sendDecision(ctx, { sessionId: key, fingerprint, op, triggerSource })
  } catch (error) {
    const detail = describeError(error)
    log({ type: 'auto-drive-failed', sessionId: key, detail })
    return settle(key, { phase: 'failed', reason: 'send-failed', stopReason: detail, extra: { lastError: detail } })
  } finally {
    inFlightBySession.delete(key)
  }
}

/**
 * 发送已判定结果。**发送前必须重新校验三件事**：
 *   1) 全局闸门（stop / takeover 可能在判断或退避期间发生）；
 *   2) 租约（可能在这一刻到期 / 达轮数 / 耗尽预算）；
 *   3) 卡片仍是最新（会话可能已经翻页，旧选择不得盲目重放）。
 * 另外：若此前尝试过发送，先做平台读回，确认消息**不存在**才发（防重复）。
 */
async function sendDecision(ctx, { sessionId, fingerprint, op, triggerSource }) {
  const now = clock()
  if (!op) return { ok: false, reason: 'no-op-record' }

  // 退避窗口内不重试（恢复通道后仍会自动重试，不至于高频撞墙）。
  if (op.phase === 'retryable-failed' && op.nextRetryAt && Date.parse(op.nextRetryAt) > now) {
    updateRuntimeDetail(sessionId, { phase: 'retryable-failed', reason: 'retry-backoff' })
    return { ok: false, reason: 'retry-backoff', nextRetryAt: op.nextRetryAt }
  }

  const gate = globalGate()
  if (!gate.allowed) {
    patchLease(sessionId, { phase: gate.phase, reason: gate.reason, stopReason: gate.reason }, { now: clock() })
    updateRuntimeDetail(sessionId, { phase: gate.phase, reason: gate.reason })
    return { ok: false, reason: gate.reason, phase: gate.phase }
  }
  const verdict = leaseVerdict(getLease(sessionId), now)
  if (!verdict.allowed) {
    return settle(sessionId, { phase: verdict.phase, reason: verdict.reason, stopReason: verdict.reason })
  }

  // 卡片是否仍是最新：不是就按「被新版本取代」处理，交给下一轮重新判断。
  const fresh = await readSessionSnapshot(ctx, sessionId)
  if (fresh.exists) {
    const freshCard = fresh.text?.includes('[DECISION_POINT]')
      ? fresh.text.slice(fresh.text.indexOf('[DECISION_POINT]')).trim()
      : null
    if (freshCard === null || fingerprintOf(sessionId, normalizeText(freshCard)) !== fingerprint) {
      markStale(sessionId, fingerprint, { now: clock() })
      return settle(sessionId, { phase: 'observing', reason: 'stale-card' })
    }
  }

  // 已经尝试发送过 → 先读回（回执可能丢失，但消息可能已经落盘）。
  if ((op.sendAttempts ?? 0) > 0 || op.phase === 'sending') {
    const found = verifySubmitted(fresh, op)
    if (found) {
      commitOp(sessionId, op, { via: 'readback', at: nowIso(clock()), detail: '恢复读回：消息已存在' })
      return { ok: true, picked: op.picked, recovered: true }
    }
  }

  const lock = acquireDecisionLock({
    sessionId, fingerprint, instanceId: INSTANCE, ttlMs: CONFIG.lockTtlMs, now: clock(), phase: 'sending',
  })
  if (!lock.ok) return { ok: false, reason: 'locked-by-peer', holder: lock.holder }

  try {
    const attempt = (op.sendAttempts ?? 0) + 1
    op = upsertOp({
      ...op,
      phase: 'sending',
      sendAttempts: attempt,
      sendingAt: nowIso(clock()),
      holder: INSTANCE,
      triggerSource,
    }, { now: clock() })
    updateRuntimeDetail(sessionId, { phase: 'sending', sendAttempts: attempt })
    patchLease(sessionId, { phase: 'sending' }, { now: clock(), touchActivity: false })

    // 落 sending 之后再查一次闸门：stop 若在这一刻发生，发送必须取消。
    const finalGate = globalGate()
    if (!finalGate.allowed) {
      upsertOp({
        ...op, phase: 'decided', blockedBy: finalGate.phase, reason: finalGate.reason, blockedAt: nowIso(clock()),
      }, { now: clock() })
      updateRuntimeDetail(sessionId, { phase: finalGate.phase, reason: finalGate.reason })
      patchLease(sessionId, {
        phase: finalGate.phase, reason: finalGate.reason, stopReason: finalGate.reason,
      }, { now: clock() })
      return { ok: false, reason: finalGate.reason, phase: finalGate.phase }
    }

    try {
      const receipt = await promptSession(ctx, sessionId, op.submittedText)
      if (faultHit('crash-after-send')) {
        // 最危险的窗口：DSH 已接受投递，但完成记录还没写。恢复必须先平台读回。
        log({ type: 'fault-crash-after-send', sessionId })
        process.kill(process.pid, 'SIGKILL')
        return { ok: false, reason: 'crashed' }
      }
      commitOp(sessionId, op, { via: receipt?.via ?? 'unknown', at: nowIso(clock()), detail: receipt?.raw ?? null })
      releaseDecisionLock(sessionId, fingerprint, { instanceId: INSTANCE })
      return { ok: true, picked: op.picked, receipt }
    } catch (error) {
      const detail = describeError(error)
      const nextRetryAt = nowIso(clock() + backoffMs(attempt))
      upsertOp({
        ...op,
        phase: 'retryable-failed',
        lastError: detail,
        failedAt: nowIso(clock()),
        nextRetryAt,
        attempts: attempt,
      }, { now: clock() })
      patchLease(sessionId, {
        phase: 'retryable-failed',
        reason: 'send-failed-retryable',
        lastError: detail,
        nextRetryAt,
      }, { now: clock(), history: { event: 'send-failed', attempt, note: detail } })
      appendDecision({
        ...evidenceSummary(op),
        outcome: 'send-failed',
        attempt,
        sendOutcome: 'retryable-failed',
        lastError: detail,
        nextRetryAt,
        at: nowIso(clock()),
      })
      log({ type: 'auto-drive-send-failed', sessionId, attempt, detail, nextRetryAt })
      releaseDecisionLock(sessionId, fingerprint, { instanceId: INSTANCE })
      return { ok: false, reason: 'send-failed-retryable', error: detail, nextRetryAt }
    }
  } catch (error) {
    releaseDecisionLock(sessionId, fingerprint, { instanceId: INSTANCE })
    throw error
  }
}

/** 平台读回：会话里是否已经存在这一条带标记的用户消息。 */
export function verifySubmitted(snapshot, op) {
  if (!snapshot?.events) return null
  const marked = findMarkedUserMessages(snapshot.events, AUTO_REPLY_PREFIX)
  const wanted = normalizeText(op?.submittedText)
  return marked.find((m) => normalizeText(m.text) === wanted)
    ?? marked.find((m) => op?.picked && normalizeText(m.text).endsWith(normalizeText(op.picked)))
    ?? null
}

/** 提交：只有这里会把卡片写成 committed（= 收到 DSH 明确回执 / 读回确认）。 */
export function commitOp(sessionId, op, receipt) {
  const record = upsertOp({
    ...op,
    phase: 'committed',
    committedAt: receipt?.at ?? nowIso(clock()),
    receipt,
    awaitingUsageAfter: true,
  }, { now: clock() })
  rememberAutoReply(sessionId, op.submittedText, { provider: op.replyProvider ?? null })
  const lease = getLease(sessionId)
  accountRound(sessionId, {
    submission: {
      text: summarize(op.submittedText, 200),
      picked: summarize(op.picked, 120),
      at: receipt?.at ?? nowIso(clock()),
      opId: op.fingerprint,
    },
    receipt,
    now: clock(),
  })
  appendDecision({
    ...evidenceSummary(record),
    outcome: 'auto-drive-answered',
    jevInputTokens: op.jev?.inputTokens ?? null,
    jevOutputTokens: op.jev?.outputTokens ?? null,
    dshInputTokensBefore: op.dshUsageBefore ?? null,
    dshInputTokensAfter: null,
    cacheReadTokens: null,
    round: lease?.completedRounds ?? null,
    replyProvider: op.replyProvider ?? lease?.replyProvider ?? null,
    leaseId: op.leaseId ?? null,
    instanceId: INSTANCE,
    submittedText: summarize(op.submittedText, 200),
    sendOutcome: 'confirmed',
    receipt,
    at: receipt?.at ?? nowIso(clock()),
  })
  updateRuntimeDetail(sessionId, {
    phase: 'sent',
    picked: summarize(op.picked, 120),
    submittedText: summarize(op.submittedText, 200),
    receipt,
  })
  log({ type: 'auto-drive-answered', sessionId, picked: summarize(op.picked, 120), via: receipt?.via ?? null })
  return record
}

/** 把「提交后主模型新增的 token」归到刚刚那一轮（取不到就保持 null，界面显示无法取数）。 */
function attributePendingUsage(sessionId, folded) {
  const ops = readOps().sessions[sessionId] ?? {}
  for (const op of Object.values(ops)) {
    if (op?.phase !== 'committed' || op.awaitingUsageAfter !== true) continue
    const before = Number.isFinite(op.dshUsageBefore) ? op.dshUsageBefore : null
    const after = folded.total
    const delta = before === null ? null : Math.max(0, after - before)
    // 只在**真的看到增长**（或等太久）时才结束归集：
    // 主回合刚落盘前观察到的 delta=0 是「还没轮到」，不是「这一轮没花钱」，
    // 提前收工会让每轮成本留白（实测踩过）。
    const waitedMs = clock() - Date.parse(op.committedAt ?? op.updatedAt ?? 0)
    if ((delta ?? 0) <= 0 && waitedMs < 10 * 60_000) continue
    upsertOp({ ...op, awaitingUsageAfter: false, dshUsageAfter: after, dshDelta: delta }, { now: clock() })
    const lease = getLease(sessionId)
    patchLease(sessionId, {
      lastRoundUsage: {
        opId: op.fingerprint,
        before,
        after,
        delta,
        cacheRead: folded.cacheRead,
        uncachedInput: folded.uncachedInput,
        output: folded.output,
        at: nowIso(clock()),
      },
    }, { now: clock(), touchActivity: false })
    appendDecision({
      ...evidenceSummary(op),
      outcome: 'usage-attributed',
      dshInputTokensBefore: before,
      dshInputTokensAfter: after,
      dshDeltaTokens: delta,
      uncachedInputTokens: folded.uncachedInput,
      cacheReadTokens: folded.cacheRead,
      outputTokens: folded.output,
      round: lease?.completedRounds ?? null,
      maxRounds: lease?.maxRounds ?? null,
      at: nowIso(clock()),
    })
    break
  }
}

// ---------------------------------------------------------------- 扫描与恢复

/**
 * 开启/续期对某会话的接管（唯一入口：路由的 `/watchkeeper/watch/toggle` 与测试都走它）。
 * @param options `{ maxRounds, tokenBudget, ttlMs, now }`。
 */
export function isExcludedSession(sessionId) {
  const id = String(sessionId ?? '')
  if (id === '') return false
  if (Array.isArray(CONFIG.excludedSessions) && CONFIG.excludedSessions.includes(id)) return true
  return Array.isArray(CONFIG.excludedSessionPrefixes)
    && CONFIG.excludedSessionPrefixes.some(prefix => typeof prefix === 'string' && prefix !== '' && id.startsWith(prefix))
}

/** 被排除会话的拒绝原因（给界面与日志同一句话）。 */
export function exclusionReason(sessionId) {
  return `watchkeeper：会话 ${sessionId} 属于通道镜像/通道执行会话（对面是真人），不得开启自动接管；`
    + '如需按 the operator 明确授权的项目任务自动推进，请用任务授权开启（authorizedBy=task + taskId）'
}

/** 通道**真实执行会话**前缀：the operator 本人在微信 / 飞书里跑任务的那条会话。 */
const CHANNEL_EXECUTION_PREFIXES = ['weixin-', 'feishu-']

/**
 * 是否通道真实执行会话（对面是 the operator 本人）。
 * 镜像窗口（`mirror-`）**不算** —— 那是只读归档，不该被代答。
 * @param {string} sessionId - 会话 id。
 * @returns {boolean} 命中返回 true。
 */
export function isChannelExecutionSession(sessionId) {
  const id = String(sessionId ?? '')
  if (id === '' || id.startsWith('mirror-')) return false
  return CHANNEL_EXECUTION_PREFIXES.some(prefix => id.startsWith(prefix))
}

/**
 * 是否**带任务授权**（the operator 明确要求执行的项目任务）。
 *
 * 为什么单独立一个判据：2026-10-07 the operator 要求区分两种事 ——
 *   · 「替 the operator 发言」（普通聊天、镜像窗口）→ 继续一律排除；
 *   · 「按 the operator 已授权任务自动推进」→ 允许在**真实执行会话**上按任务开值守。
 * 两者靠「有没有任务授权」区分，**不是**靠清空排除前缀。
 * @param {object} options - `{ authorizedBy, taskId }`。
 * @returns {boolean} 是任务授权返回 true。
 */
export function isTaskAuthorized(options = {}) {
  return options.authorizedBy === 'task'
    && typeof options.taskId === 'string' && options.taskId.trim() !== ''
}

export function enableTakeover(sessionId, options = {}) {
  const taskAuthorized = isTaskAuthorized(options)
  // 硬闸：被排除的会话一律拒绝，且**不落租约**（不是「开了但不动」）。
  // 唯一例外（the operator 2026-10-07）：**明确授权的项目任务** + **通道真实执行会话** —— 这是「按任务自动推进」，
  // 不是「替 the operator 发言」；普通聊天没有任务授权，镜像窗口 `mirror-` 永远不算执行会话。
  if (isExcludedSession(sessionId) && !(taskAuthorized && isChannelExecutionSession(sessionId))) {
    const error = new Error(exclusionReason(sessionId))
    error.code = 'session-excluded'
    throw error
  }
  return enableLease(sessionId, {
    instanceId: INSTANCE,
    owner: 'watchkeeper',
    // CODEX: maxRounds is intentionally ignored; the task stops on verified completion.
    maxRounds: null,
    // 任务授权的来源与任务号落进租约：供「任务结算即停」与事后审计用（普通开启不写这两个字段）。
    ...(taskAuthorized ? { authorizedBy: 'task', taskId: String(options.taskId).trim() } : {}),
    replyProvider: ['codex', 'fallback'].includes(options.replyProvider)
      ? options.replyProvider
      : (getLease(sessionId)?.replyProvider ?? CONFIG.defaultReplyProvider),
    // CODEX: Preserve explicit Provider switches when a session takeover starts or renews.
    openclawEnabled: options.openclawEnabled === true,
    fallbackEnabled: options.fallbackEnabled === true,
    hermesFallback: options.hermesFallback === true,
    tokenBudget: Number(options.tokenBudget ?? CONFIG.tokenBudget),
    ttlMs: Number(options.ttlMs ?? CONFIG.leaseTtlMs),
    now: options.now ?? clock(),
  })
}

/** 关闭接管（保留累计轮数与用量证据）。 */
export function disableTakeover(sessionId, reason = 'toggle-off') {
  return disableLease(sessionId, reason)
}

/** 当前有效的接管会话（租约启用且未过期）。历史遗留会话不在此列。 */
export function activeSessions(now = clock()) {
  return Object.values(listLeases()).filter((lease) => leaseVerdict(lease, now).allowed)
}

/**
 * 遍历所有**有效租约**会话，各跑一次推进。
 * 历史遗留的开关（无租约）与到期的租约都不会被扫到 —— 这是「重启后不推进旧测试会话」的实现点。
 */
/**
 * 本宿主有没有**会话读取能力**（一次探测，按 ctx 缓存）。
 *
 * 判据就是 `readSessionSnapshot` 自己的终局分支 `error === 'no-session-reader'`：
 * 拿一个不可能存在的会话 id 探一次，能走到「读不到」而不是「压根没读取器」即算有能力。
 * 探测只读、不写租约、不落判定。
 */
const readerCapability = new WeakMap()
const noReaderLogged = new Set()
let readerProbeSeq = 0

function readerProbeKey(ctx) {
  if (!readerCapability.has(ctx)) readerCapability.set(ctx, { key: `ctx-${++readerProbeSeq}` })
  return readerCapability.get(ctx).key
}

export async function hasSessionReader(ctx) {
  const cached = readerCapability.get(ctx)
  if (cached && typeof cached.has === 'boolean') return cached.has
  let has = true
  try {
    const probe = await readSessionSnapshot(ctx, '__watchkeeper-reader-probe__')
    has = probe?.error !== 'no-session-reader'
  } catch {
    has = false
  }
  readerCapability.set(ctx, { ...(cached ?? {}), key: cached?.key ?? `ctx-${++readerProbeSeq}`, has })
  return has
}

export async function sweepSessions(ctx, triggerSource = 'sweep') {
  const results = {}
  // 本宿主读不到会话时**整体跳过**：没有读取能力的宿主没有资格判断、更不许改写
  // 别的宿主写的租约。实测形态（2026-10-11）：通道 profile 撤了 session-controller 依赖链，
  // 但 watchkeeper 仍被 bootstrap 按声明挂回 → 每 60 秒把桌面会话的租约写成 session-missing，
  // 界面因此显示「会话不存在」（飞书 6127 行 / 微信 11304 行日志）。
  if (!(await hasSessionReader(ctx))) {
    const key = readerProbeKey(ctx)
    if (!noReaderLogged.has(key)) {
      noReaderLogged.add(key)
      log({ type: 'sweep-skipped', reason: 'no-session-reader', detail: '本宿主没有会话读取器，跳过周期扫描（不改写租约）' })
    }
    return results
  }
  for (const lease of activeSessions()) {
    const sessionId = lease.sessionId
    try {
      results[sessionId] = await autoDriveSession(ctx, sessionId, triggerSource)
    } catch (error) {
      results[sessionId] = { ok: false, error: describeError(error) }
    }
  }
  return results
}

/**
 * 崩溃恢复扫描（幂等，可在启动时与任意时刻重复跑）：
 *   · `judging` 过期（本进程崩在判断中）→ 重置为 `new`，下一轮重新判断；
 *   · `sending` 过期（崩在发送中/回执丢失）→ **先平台读回**：消息在 → committed；不在 → retryable-failed；
 *   · `decided` 原样保留（复用已保存的判断结果，不重复调用 judge）；
 *   · 陈旧决策锁自然过期，允许另一端接管。
 */
export async function recoverPending(ctx, { now = clock() } = {}) {
  const ops = readOps()
  const report = { judging: [], sending: [], committedByReadback: [], retryable: [], locksReleased: 0 }
  const grace = Number(CONFIG.recoveryGraceMs) || 30_000

  for (const [sessionId, bucket] of Object.entries(ops.sessions)) {
    for (const op of Object.values(bucket)) {
      const age = now - Date.parse(op?.updatedAt ?? 0)
      if (op?.phase === 'judging' && age > grace) {
        const lock = readDecisionLock(sessionId, op.fingerprint)
        const lockAlive = lock && (!lock.expiresAt || Date.parse(lock.expiresAt) > now) && lock.instanceId !== INSTANCE
        if (lockAlive) continue // 另一个实例正在判断，不抢
        upsertOp({ ...op, phase: 'new', recoveredAt: nowIso(now), reason: 'recovered-before-judging' }, { now })
        report.judging.push({ sessionId, fingerprint: op.fingerprint })
      }
      if (op?.phase === 'sending' && age > grace) {
        const snapshot = await readSessionSnapshot(ctx, sessionId)
        const found = snapshot.exists ? verifySubmitted(snapshot, op) : null
        if (found) {
          commitOp(sessionId, op, { via: 'recovery-readback', at: nowIso(now), detail: '崩溃恢复：读回确认已投递' })
          report.committedByReadback.push({ sessionId, fingerprint: op.fingerprint })
        } else {
          upsertOp({
            ...op,
            phase: 'retryable-failed',
            lastError: 'crash-before-receipt',
            nextRetryAt: nowIso(now + backoffMs(op.sendAttempts ?? 1)),
            recoveredAt: nowIso(now),
          }, { now })
          report.retryable.push({ sessionId, fingerprint: op.fingerprint })
        }
      }
    }
  }

  // 陈旧锁：持有者进程已死（TTL 过期）且没有活跃操作 → 清掉，避免「锁在、没人发」。
  for (const lock of listDecisionLocks({ now })) {
    if (!lock.expired) continue
    const op = findOp(lock.sessionId, lock.fingerprint)
    if (op && ['committed', 'needs-human', 'stale', 'failed'].includes(op.phase)) {
      releaseDecisionLock(lock.sessionId, lock.fingerprint, { force: true })
      report.locksReleased += 1
    }
  }
  if (report.judging.length || report.sending.length || report.committedByReadback.length) {
    log({ type: 'recovery', ...report })
  }
  return report
}

// ---------------------------------------------------------------- HTTP 接口

function cors(res, req) {
  res.setHeader('access-control-allow-origin', req.headers.origin ?? '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
}

function json(res, code, body) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) }
    })
  })
}

/** 对外状态快照：开关 + 租约摘要 + 全局控制面 + 锁 + 客户端自检。 */
export function stateSnapshot({ now = clock() } = {}) {
  const leases = listLeases()
  const sessions = {}
  const control = {}
  // 全局闸门单独表达，**不覆盖会话相位**：一次已被 DSH 确认的发送必须如实显示「已发送」，
  // 同时告诉界面「现在全局在停」，两者是不同的事实，不能互相顶掉。
  const gate = globalGate()
  for (const [sessionId, lease] of Object.entries(leases)) {
    const verdict = leaseVerdict(lease, now)
    // 防御：被排除的会话一律如实报「未启用」，并给出原因（历史租约不作数）。
    // 例外：**带任务授权**的租约（the operator 明确授权的项目任务 + 通道真实执行会话）如实报它的 verdict。
    const taskAuthorizedLease = lease.authorizedBy === 'task'
      && typeof lease.taskId === 'string' && lease.taskId !== ''
    sessions[sessionId] = isExcludedSession(sessionId) && !taskAuthorizedLease ? false : verdict.allowed
    const summary = statusSummary(lease, now)
    control[sessionId] = {
      // 顺序很重要：**租约摘要优先**，运行细节只补它没有的字段。
      // 反过来的话，内存里上一次动作的旧 reason 会盖住权威相位/原因
      // （实测：轮数上限已停，界面却还显示「预算耗尽」）。
      ...detailOf(sessionId),
      ...summary,
      enabled: verdict.allowed,
      globalBlocked: !gate.allowed,
      globalPhase: gate.phase,
      globalReasonLabel: gate.reason ? reasonText(gate.reason) : null,
      replyProvider: lease.replyProvider ?? CONFIG.defaultReplyProvider,
      openclawEnabled: lease.openclawEnabled === true,
      fallbackEnabled: lease.fallbackEnabled === true,
      hermesFallback: lease.hermesFallback === true,
    }
    if (lease.reason === 'legacy-no-lease' || lease.stopReason === 'legacy-migrated') {
      control[sessionId].legacy = true
      control[sessionId].reasonLabel = reasonText('legacy-no-lease')
    }
  }
  return {
    ok: true,
    version: 2,
    instanceId: INSTANCE,
    pid: process.pid,
    defaultEnabled: CONFIG.defaultEnabled === true,
    approveThreshold: CONFIG.approveThreshold,
    limits: {
      maxRounds: null,
      tokenBudget: CONFIG.tokenBudget,
      leaseTtlMs: CONFIG.leaseTtlMs,
      sweepIntervalMs: CONFIG.sweepIntervalMs,
    },
    sessions,
    leases,
    legacy: listLegacy(),
    control,
    autoReplies: readAutoReplies(),
    global: readGlobalControl(),
    locks: listDecisionLocks({ now }),
    client: lastBeacon,
    at: nowIso(now),
  }
}

/**
 * 宿主半入口。
 * @param ctx Cordis 上下文。
 * @param rawConfig cordis 的插件配置。
 */
export function apply(ctx, rawConfig = {}, runtimeServices = {}) {
  ctx.inject?.(['sessions', 'agents'], child => { optionalRuntimes.set(ctx, { sessions: child.get('sessions'), agents: child.get('agents') }); return () => optionalRuntimes.delete(ctx) })
  // 界面服务可选：它缺席不阻断手机通道，已有 agents/sessions 可处理热会话。
  ctx.inject?.(['sessionController'], (child) => {
    optionalControllers.set(ctx, child.get('sessionController'))
    return () => optionalControllers.delete(ctx)
  })
  // 手机没有网页开关，允许当前 Agent 按已授权任务开启自己的值守。
  ctx.inject?.(['tools'], (child) => {
    if (rawConfig.taskTool?.enabled === false) return
    const dispose = child.get('tools').register({
    name: 'watchkeeper_task',
    description: 'Turn watch mode on for the current session when an explicitly authorized task must run unattended. Turn it off when the task completes or pauses. Requires a task id; do not use it for ordinary chat.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['enable', 'disable'] },
        target: { type: 'string', enum: ['current-session'] },
        params: { type: 'object', properties: { taskId: { type: 'string', minLength: 1 } }, required: ['taskId'] },
        evidence_required: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['action', 'target', 'params', 'evidence_required'],
    },
    execute(args, exec) {
      if (!['enable', 'disable'].includes(args.action) || args.target !== 'current-session' || !args.evidence_required?.length) throw new Error('input_format: missing action/target/params/evidence_required')
      const sessionId = exec?.agent?.id
      if (!sessionId || !args.params?.taskId?.trim()) throw new Error('session id and task id are required')
      const lease = args.action === 'enable'
        ? enableTakeover(sessionId, { authorizedBy: 'task', taskId: args.params.taskId })
        : disableTakeover(sessionId, 'task-agent-disabled')
      return { sessionId, taskId: args.params.taskId, enabled: args.action === 'enable', lease }
    },
    output: {
      schema: { type: 'object', properties: { sessionId: { type: 'string' }, taskId: { type: 'string' }, enabled: { type: 'boolean' }, lease: { type: ['object', 'null'] } }, required: ['sessionId', 'taskId', 'enabled'] },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    presentCall: () => ({ card: 'generic', title: 'Watch mode' }),
    presentResult: () => ({ card: 'generic' }),
    })
    log({ type: 'task-tool-registered', enabled: true })
    return dispose
  })
  let disposeRoute
  const timers = new Set()
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!disposedContexts.has(ctx)) fn() }, ms)
    timers.add(timer)
    return timer
  }
  const cleanup = () => {
    disposedContexts.add(ctx)
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer) }
    timers.clear()
    try { disposeRoute?.() } catch { /* already released */ }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else ctx.on('dispose', cleanup)
  CONFIG = { ...Config, ...rawConfig }
  ensureDir(stateDir())
  // 旧格式迁移（历史 true → 过期记录）：启动即落地，证据保留在 legacy 段。
  const migrated = persistMigration(clock())
  log({
    type: 'ready',
    instance: INSTANCE,
    codeRevision: CODE_REVISION,
    leases: Object.keys(migrated.leases ?? {}).length,
    legacy: Object.keys(migrated.legacy ?? {}).length,
    global: readGlobalControl().state,
  })

  // 启动即做一次崩溃恢复；失败不影响挂载。
  void recoverPending(ctx).catch((error) => log({ type: 'recovery-failed', detail: describeError(error) }))
  try { pruneOps({ now: clock() }) } catch (error) { log({ type: 'prune-failed', detail: describeError(error) }) }

  // ── 瀑布挂点：工具提问抢答 or 转人工 ───────────────────────────────────────
  ctx.on('user-questions/request', (request, next) => {
    const sessionId = request?.agent?.id ?? null
    const lease = getLease(sessionId)
    const verdict = leaseVerdict(lease, clock())
    if (!verdict.allowed) return next()
    const gate = globalGate()
    if (!gate.allowed) {
      updateRuntimeDetail(sessionId, { phase: gate.phase, reason: gate.reason })
      patchLease(sessionId, { phase: gate.phase, reason: gate.reason, stopReason: gate.reason }, { now: clock() })
      return next()
    }
    const questions = request?.questions ?? []
    return judge(questions, sessionId)
      .then(async (result) => {
        if (disposedContexts.has(ctx) || !globalGate().allowed) return next()
        if (result.kind !== 'answer' && lease?.fallbackEnabled === true && canFallbackReply(result.reason, JSON.stringify(questions))) {
          const answers = []
          for (const question of questions) {
            const generated = await generateProviderReply({ provider: 'fallback', parsed: question, picked: '回答当前非资金问题；具体操作派发给 DSH 自行执行并要求读回证据。', detail: result.detail })
            if (disposedContexts.has(ctx) || !globalGate().allowed) return next()
            answers.push({ id: question.id, selected: [], custom: formatFallbackReply(generated?.text) })
          }
          appendDecision({ sessionId, outcome: 'tool-hermes-handoff', reason: result.reason, at: nowIso(clock()) })
          return { answers }
        }
        if (result.detail?.judgeUsage) accountJudgeUsage(sessionId, result.detail.judgeUsage, { now: clock() })
        if (result.kind === 'answer') {
          const picked = result.answer.answers[0].selected[0]
          const submittedText = formatAutoReply(picked)
          rememberAutoReply(sessionId, submittedText)
          appendDecision({
            ...evidenceSummary({
              sessionId,
              fingerprint: `tool:${normalizeText(questions?.[0]?.question).slice(0, 40)}`,
              question: questions?.[0]?.question,
              triggerSource: 'user-questions',
              options: (questions?.[0]?.options ?? []).map((o) => String(o?.label ?? '')),
            }),
            picked,
            submittedText: summarize(submittedText, 200),
            outcome: 'tool-answered',
            sendOutcome: 'in-process-waterfall',
            at: nowIso(clock()),
          })
          return result.answer
        }
        return next()
      })
      .catch((error) => {
        log({ type: 'judge-failed', message: describeError(error) })
        return next()
      })
  })

  // ── 对外服务：让**其他通道**（如飞书通道）能用对话命令开关值守 ──────────────────
  // 为什么做成服务而不是让别的插件直接改 leases.json：状态语义（租约/时窗/红线回执/审计）
  // 只有一个 home —— 就是本文件。别的插件只调这里，不复制写入逻辑。
  // 契约：取不到本服务时调用方必须优雅降级（飞书通道会回一句「本通道未挂值守能力」）。
  function setReplyProvider(sessionId, provider, enabled) {
    const patch = {}
    if (!['codex', 'agy', 'custom'].includes(provider)) throw new Error(`unknown reply provider: ${provider}`)
    patch.replyProvider = enabled ? provider : 'none'
    patchLease(sessionId, patch, {
      now: clock(), touchActivity: false, history: { event: 'reply-provider-toggled', note: `${provider}:${enabled}` },
    })
    updateRuntimeDetail(sessionId, patch)
    return patch
  }

  const provideDutyService = () => {
    ctx.provide('watchkeeper', {
      /** 全局值守快照 + 指定会话的租约。 */
      state: (sessionId) => ({
        snapshot: stateSnapshot(),
        lease: sessionId ? (getLease(sessionId) ?? null) : null,
      }),
      /** judge 值守开关。红线或闸门拒绝时抛错（错误带 code），调用方据实回话。 */
      toggleTakeover: (sessionId, enabled) => {
        if (!sessionId) throw new Error('sessionId required')
        if (enabled) {
          const lease = enableTakeover(sessionId, {})
          log({ type: 'toggle', sessionId, enabled: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt, source: 'service' })
          later(() => { autoDriveSession(ctx, sessionId, 'toggle').catch(() => {}) }, 50)
          return { enabled: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt }
        }
        disableTakeover(sessionId, 'toggle-off')
        log({ type: 'toggle', sessionId, enabled: false, source: 'service' })
        return { enabled: false }
      },
      /** a reply provider / a reply provider 接管开关。 */
      toggleProvider: (sessionId, provider, enabled) => {
        if (!sessionId) throw new Error('sessionId required')
        const patch = setReplyProvider(sessionId, provider, enabled)
        log({ type: 'provider-toggle', sessionId, provider, enabled, source: 'service' })
        return patch
      },
    })
  }
  // 老 build 或测试替身可能没有 ctx.provide：服务不可用时**静默跳过**，插件本体照常工作
  // （调用方取不到 `jevWatch` 会优雅降级）。绝不让「注册服务」这件事影响值守主流程。
  if (typeof ctx.provide === 'function') {
    try {
      provideDutyService()
    } catch (error) {
      log({ type: 'provide-service-failed', message: describeError(error) })
    }
  }

  // ── 对话正文 [DECISION_POINT] 自动化驱动 ──────────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      const sessionId = session?.id
      if (!sessionId) return
      if (event.type === 'assistant/message') {
        const textBlocks = event.data?.message?.content?.filter?.((b) => b.type === 'text')?.map?.((b) => b.text) || []
        if (textBlocks.length > 0) {
          lastAssistantMessageBySession.set(sessionId, textBlocks.join('\n'))
          if (leaseVerdict(getLease(sessionId), clock()).allowed) {
            updateRuntimeDetail(sessionId, { phase: 'observing', reason: 'assistant-message' })
          }
        }
      } else if (event.type === 'turn/end') {
        if (leaseVerdict(getLease(sessionId), clock()).allowed) {
          later(() => { autoDriveSession(ctx, sessionId, 'turn/end').catch(() => {}) }, 50)
        }
      }
    } catch (e) {
      log({ type: 'session-event-error', message: describeError(e) })
    }
  })

  ctx.on('api-session/status', (sessionId, running) => {
    try {
      if (!leaseVerdict(getLease(sessionId), clock()).allowed) return
      updateRuntimeDetail(sessionId, {
        phase: running ? 'running' : 'checking',
        reason: running ? 'agent-running' : 'agent-idle',
      })
      if (!running) later(() => { autoDriveSession(ctx, sessionId, 'api-session/status').catch(() => {}) }, 100)
    } catch (e) {
      log({ type: 'api-session-status-error', message: describeError(e) })
    }
  })

  // ── 周期扫描：把「已经停住、不会再发事件」的会话也纳入 ──────────────────
  const sweepIntervalMs = Number(CONFIG.sweepIntervalMs)
  if (Number.isFinite(sweepIntervalMs) && sweepIntervalMs > 0) {
    const sweepTimer = setInterval(() => {
      void sweepSessions(ctx, 'interval').catch((error) => {
        log({ type: 'sweep-failed', detail: describeError(error) })
      })
    }, sweepIntervalMs)
    timers.add(sweepTimer)
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
    ctx.on('dispose', () => clearInterval(sweepTimer))
    log({ type: 'sweep-timer-armed', intervalMs: sweepIntervalMs })
  }

  // ── 控制通道 ───────────────────────────────────────────────────────────
  function attachRoutes(webServer) {
    if (!webServer || typeof webServer.register !== 'function') {
      throw new TypeError('webServer service is missing register()')
    }
    disposeRoute = webServer.register({
      kind: 'prefix',
      path: '/watchkeeper/watch',
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        cors(res, req)
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
        try {
          if (url.pathname === '/watchkeeper/watch/state') {
            json(res, 200, stateSnapshot())
            return
          }
          if (url.pathname === '/watchkeeper/watch/health') {
            json(res, 200, {
              ok: true,
              instanceId: INSTANCE,
              codeRevision: CODE_REVISION,
              handoffRevision: '2026-10-07-nonfinancial-v1',
              watchResponsibility: { revision: WATCH_RESPONSIBILITY_REVISION, role: 'answer-only', executor: 'DSH' },
              pid: process.pid,
              replyAuthority: {
                revision: '2026-10-07-execution-first-v1',
                selfPromiseCorrected: guardReplyAuthority('我登录一次 Seller Center 并手选类目').corrected,
                userDispatchCorrected: guardReplyAuthority('你手选类目并截图').corrected,
              },
              stateDir: stateDir(),
              files: {
                leases: FILES.leases,
                legacyState: FILES.legacyState,
                ops: FILES.ops,
                locks: FILES.locks,
                decisions: FILES.decisions,
              },
              global: readGlobalControl(),
              activeLeases: activeSessions().map((lease) => lease.sessionId),
              locks: listDecisionLocks(),
              config: {
                maxRounds: null,
                defaultReplyProvider: CONFIG.defaultReplyProvider,
                judgmentProject: CONFIG.judgmentProject,
                tokenBudget: CONFIG.tokenBudget,
                leaseTtlMs: CONFIG.leaseTtlMs,
                approveThreshold: CONFIG.approveThreshold,
              },
            })
            return
          }
          if (url.pathname === '/watchkeeper/watch/beacon' && req.method === 'POST') {
            const body = await readBody(req)
            lastBeacon = { ...body, at: nowIso() }
            json(res, 200, { ok: true })
            return
          }
          if (url.pathname === '/watchkeeper/watch/toggle' && req.method === 'POST') {
            const body = await readBody(req)
            const sessionId = String(body.sessionId ?? '')
            if (!sessionId) { json(res, 400, { ok: false, message: 'sessionId required' }); return }
            if (body.enabled === true) {
              let lease
              try {
                lease = enableTakeover(sessionId, body)
              } catch (error) {
                json(res, 403, { ok: false, code: error?.code ?? 'enable-refused', message: String(error?.message ?? error) })
                return
              }
              log({ type: 'toggle', sessionId, enabled: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt })
              later(() => { autoDriveSession(ctx, sessionId, 'toggle').catch(() => {}) }, 50)
            } else {
              disableTakeover(sessionId, 'toggle-off')
              log({ type: 'toggle', sessionId, enabled: false })
            }
            json(res, 200, { ok: true, state: stateSnapshot() })
            return
          }
          if (url.pathname === '/watchkeeper/watch/provider' && req.method === 'POST') {
            const body = await readBody(req)
            const sessionId = String(body.sessionId ?? '')
            const provider = String(body.provider ?? '')
            const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true
            if (!sessionId || !['codex', 'fallback'].includes(provider)) {
              json(res, 400, { ok: false, message: 'sessionId and provider(openclaw|hermes) required' })
              return
            }
            // 与对话命令共用同一份写入逻辑（单一 home），路由不再自己拼 patch。
            setReplyProvider(sessionId, provider, enabled)
            json(res, 200, { ok: true, state: stateSnapshot() })
            return
          }
          if (url.pathname === '/watchkeeper/watch/sweep' && req.method === 'POST') {
            const body = await readBody(req).catch(() => ({}))
            const results = await sweepSessions(ctx, body?.triggerSource ?? 'sweep')
            json(res, 200, { ok: true, results, state: stateSnapshot() })
            return
          }
          if (url.pathname === '/watchkeeper/watch/recover' && req.method === 'POST') {
            const report = await recoverPending(ctx)
            json(res, 200, { ok: true, report, state: stateSnapshot() })
            return
          }
          if (url.pathname === '/watchkeeper/watch/prompt' && req.method === 'POST') {
            const body = await readBody(req)
            const sessionId = String(body.sessionId ?? '')
            const text = String(body.text ?? '')
            if (!sessionId || !text) { json(res, 400, { ok: false, message: 'sessionId and text required' }); return }
            const gate = globalGate()
            if (!gate.allowed && body.force !== true) {
              json(res, 409, { ok: false, message: 'global gate blocked', phase: gate.phase, reason: reasonText(gate.reason) })
              return
            }
            const promptResult = await promptSession(ctx, sessionId, text)
            json(res, 200, { ok: true, result: promptResult })
            return
          }
          if (url.pathname === '/watchkeeper/watch/decide' && req.method === 'POST') {
            const body = await readBody(req)
            if (FAULTS.size > 0) {
              const blocked = globalGate()
              if (!blocked.allowed) {
                json(res, 409, { ok: false, message: 'global gate blocked', phase: blocked.phase })
                return
              }
            }
            const verdict = await judge(body.questions ?? [], body.sessionId ?? 'manual-test')
            json(res, 200, verdict)
            return
          }
          if (url.pathname === '/watchkeeper/watch/ledger') {
            const sessionId = url.searchParams.get('sessionId')
            json(res, 200, {
              ok: true,
              lease: sessionId ? getLease(sessionId) : null,
              ops: sessionId ? (readOps().sessions[sessionId] ?? {}) : readOps().sessions,
              locks: listDecisionLocks(),
            })
            return
          }
          json(res, 404, { ok: false, path: url.pathname })
        } catch (error) {
          log({ type: 'http-error', path: url.pathname, detail: describeError(error) })
          try {
            json(res, 500, {
              ok: false,
              message: String(error?.message ?? error),
              code: error?.code ?? null,
              details: error?.details ?? error?.data ?? null,
            })
          } catch { /* 已发头 */ }
        }
      },
    })
  }

  // watchkeeper supplies the webServer already acquired by dsh-compat.whenService;
  // direct watchkeeper consumers retain the official injection fallback.
  if (Object.prototype.hasOwnProperty.call(runtimeServices, 'webServer')) {
    attachRoutes(runtimeServices.webServer)
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], child => {
      const server = child?.get?.('webServer') ?? child?.webServer
      if (!server) return () => {}
      attachRoutes(server)
      return () => { try { disposeRoute?.() } catch {} }
    })
  } else {
    try { const server = ctx.get?.('webServer') || ctx.webServer; if (server) attachRoutes(server) } catch {}
  }

}

// ---------------------------------------------------------------- 纯逻辑导出（回归测试用）

/** 三元规范里 ③「暂停转人工」档不入候选。 */
const HUMAN_TIER_PATTERN = /暂停|转人工|人工确认|等你|等\s*the operator|先不|暂缓|搁置|hand\s*(it\s*)?back|escalat/i

export function splitHumanTier(parsed) {
  const options = Array.isArray(parsed?.options) ? parsed.options : []
  if (options.length < 2) return { parsed, humanTier: null }
  const last = options[options.length - 1]
  const text = `${last?.label ?? ''} ${last?.detail ?? ''}`
  if (!HUMAN_TIER_PATTERN.test(text)) return { parsed, humanTier: null }
  return {
    parsed: { ...parsed, options: options.slice(0, -1) },
    humanTier: last,
  }
}

const RECOMMENDED_PATTERN = /\(recommended\)|（推荐）|\(推荐\)|推荐档/i

/** 识别三元规范里的 ① 推荐档与 ② 降级档（识别不出返回 null，调用方退回 choice 路径）。 */
export function classifyTiers(options) {
  const list = Array.isArray(options) ? options : []
  const forward = list.find((option) => RECOMMENDED_PATTERN.test(String(option?.label ?? '')))
  if (!forward) return null
  const fallback = list.find((option) => option !== forward)
  if (!fallback) return null
  return { forward, fallback }
}

export { AUTO_REPLY_PREFIX }
