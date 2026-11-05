// 评估人格（session evaluator）——判「会话任务做完了没 · 达到我们的使用标准没 · 完全合规没」。
//
// 为什么单独一个模块：值守原来只有一个「完成概率 ≥ 0.7」的粗判据（judgeCompletion），
// 它答不了两件事 —— ①做到哪一层才算够（设计 ≠ 实现 ≠ 测试 ≠ 平台读回）②合不合规。
// 实测证据：近 2000 条完成判定里 completion-confirmed 只有 12 条，其中 23 条卡在
// prob=0.65/0.66（只差 0.04 没到线）—— 证据够不够不该由一个通用概率阈值拍板。
//
// 三条轴，缺一条不算过（the operator 2026-10-12 定）：
//   · complete —— 会话最初的原始任务是否做完（证据分层，低层不冒充高层）
//   · usable   —— 是否达到项目对**这一类交付物**的使用标准
//   · compliant—— 是否完全合规（平台规则 / 项目红线 / 上架门禁），**fail-closed**
//
// 边界（写死）：评估人格只判、不放行 —— 不执行动作、不放宽任何既有门禁与红线、不构成授权。
// 判据与话术的唯一归属：integrations/watchkeeper/config/judgments.json 的 `evaluation` 段。

import { loadJudgmentProfile } from './judgments.js'

/**
 * 判定用的「项目现有门禁」清单 —— 只是**清单**，不是第二份判据实现。
 * 每条的权威实现都在它自己的脚本/技能里；评估人格引用它们取证，不复制它们的规则。
 */
export const COMPLIANCE_GATES = []

/** 证据分层（低层不得冒充高层）。 */
export const EVIDENCE_LAYERS = ['design', 'implementation', 'test', 'runtime', 'platform-verification', 'business-result']

/** 评估人格的判据本体（唯一归属：config/judgments.json 的 evaluation 段）。 */
export function loadEvaluationProfile(project = 'default') {
  const profile = loadJudgmentProfile(project)
  return profile?.evaluation ?? profile ?? {}
}

/** 三轴选择器的选项标签（与 buildEvaluationQuestions 的 criteria 键一一对应，改一处必改另一处）。 */
export const EVALUATION_CHOICES = {
  complete: ['accept_complete', 'continue_work', 'indeterminate'],
  compliant: ['compliant', 'violation', 'unknown'],
}

/**
 * 组装送给评估人格的 state（最小输入原则：只给任务与证据，不给中间过程叙述）。
 *
 * @param `{ task, completionClaim, evidence, sessionId }`
 *   task            —— 会话最初的原始任务（判定「做完」的唯一靶子）
 *   completionClaim —— 末轮的完成声明（含判据），没有就传 null
 *   evidence        —— 本轮状态摘录（读回的数值 / 命令输出 / 平台读数）
 */
export function buildEvaluationState({ task, completionClaim = null, evidence = null, sessionId = null } = {}) {
  return {
    project: 'default',
    session_id: sessionId,
    original_task: String(task ?? '').slice(0, 2000) || null,
    completion_claim: completionClaim ? String(completionClaim).slice(0, 1200) : null,
    state_evidence: evidence ? String(evidence).slice(0, 2000) : null,
    required_evidence_layers: EVIDENCE_LAYERS,
    compliance_gates: COMPLIANCE_GATES.map((gate) => ({ axis: gate.axis, id: gate.id, label: gate.label })),
  }
}

/**
 * 判定问题定义：**只有两轴，都走 judge 的 choice 原语**（不用提示词让模型吐 JSON）。
 *
 * 为什么撤掉「质量打分」轴（the operator 2026-10-12 拍板撤）：
 *   · judge 的 `score` 原语只有 3 档（legend 实测为 blocked/partial/ready），所谓「9 分线」
 *     等于「只认 ready 一档」，是伪精确 —— 实测三连都是同一个档位，没有刻度信息；
 *   · 它判的东西完成轴已经判了（同一张卡里完成轴给出 0.71 的 indeterminate，
 *     质量轴只在旁边复述一遍）；
 *   · 它和项目自己的规范打架：§4bis 要求简单问答 ≤12 行，9 分线却要求所有任务都留同等密度的
 *     证据话术 —— 简单问答会永远卡在线上被无限续跑，那是摩擦不是价值。
 *   质量本来就由既有领域门禁（图片准入 / Listing 质量 / 技能评估噪声线 / 价格合规）把关，
 *   它们都是**可机器核对**的，不需要一个通用打分。
 *
 * 合规轴也不交 judge：judge 只看 state，做不了「跨证据推理的合规判断」，实测在毫无违规证据时
 * 仍返 violation(0.88–0.90)，上线会把每条正常收尾都判成违规。改为**确定性规则命中**，
 * 见 `complianceOfText`。
 */
export function buildEvaluationQuestions(profile = loadEvaluationProfile()) {
  const persona = profile.persona ?? ''
  const rules = Array.isArray(profile.rules) ? profile.rules.join(' ') : ''
  return {
    complete: {
      type: 'choice',
      instructions: `${persona} ${rules} Judge axis 1: is the session's ORIGINAL TASK done at the required evidence layer? `
        + `${profile.complete ?? ''} Being designed or implemented is NOT done when the task requires test, runtime or platform readback.`,
      criteria: {
        accept_complete: 'The original task is done and every claim in the completion statement carries checkable evidence present in the state.',
        continue_work: `${profile.incomplete ?? 'Required work remains.'} Name the missing evidence layer.`,
        indeterminate: `${profile.indeterminate ?? 'Evidence is not present in the state.'} Do NOT pass on missing evidence.`,
      },
    },
  }
}

// ---------------------------------------------------------------- 合规轴（确定性）

/** 红线（与 host.js 的红线表同源；本文件不 import host.js，避免循环依赖）。
 *  第二列是**类别名**，只用于留痕（`red_line` 字段），不参与判定。 */
const RED_LINES = [
  ['credentials', /凭据|密码|passwo?rd|token|api[\s_-]?key|私钥|secret|验证码|实名|kyc|verif/i],
  ['money', /付款|支付|充值|提现|转账|退款|退费|扣款|汇款|refund|结算|下单(?!规则)|(?:执行|确认|立即)采购|采购扣款|pay(ment)?|checkout|withdraw|transfer\b/i],
  ['action', /发布|上线|提交|删除|清空|发送给|publish|deploy|delete|drop\b|submit/i],
]

/** 否定语境里的命中不算（例：「不提交」「not deployed」）。 */
const NEGATION_TAIL = /(?:不|无需|无须|未|免|勿|别|不用|不必|禁止|没有|never|not|no|without)\s*$/i

/** 门禁 / 读回证据的形态：脚本名、退出码、标准结论词。 */
const GATE_EVIDENCE = /gate\.py|gates?[_\s-]?(?:pass|passed|failed)|退出码\s*[0-9]|exit\s*code\s*[0-9]|读回|readback|platform[_\s-]?verification|preflight|doctor\b|测试通过|\b\d+\s*\/\s*\d+\s*(?:通过|passed)/i

/** 命中红线就返回类别名，否则 null。语义与 host.js 的 hitRedLine 一致（红线是硬边界，不能靠概率）。 */
export function hitRedLineInText(text) {
  const source = String(text ?? '')
  for (const [, pattern] of RED_LINES) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const rx = new RegExp(pattern.source, flags)
    let m
    while ((m = rx.exec(source)) !== null) {
      const before = source.slice(Math.max(0, m.index - 4), m.index)
      if (!NEGATION_TAIL.test(before)) return pattern.source
      if (rx.lastIndex === m.index) rx.lastIndex += 1
    }
  }
  return null
}

/**
 * 命中红线的**类别名**（`credentials` / `money` / `action`）；未命中返回 `'none'`。
 *
 * 只用于留痕：`hitRedLineInText` 返回的是正则原文，落进账本读起来很吵，
 * 而 `evaluation-blocked` 事后只需要一眼看出「被哪一类词绊倒」。
 * 判定本身仍以 `hitRedLineInText` 为准，本函数不改任何 verdict。
 */
export function hitRedLineCategory(text) {
  const source = String(text ?? '')
  for (const [name, pattern] of RED_LINES) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
    const rx = new RegExp(pattern.source, flags)
    let m
    while ((m = rx.exec(source)) !== null) {
      const before = source.slice(Math.max(0, m.index - 4), m.index)
      if (!NEGATION_TAIL.test(before)) return name
      if (rx.lastIndex === m.index) rx.lastIndex += 1
    }
  }
  return 'none'
}

/**
 * 合规轴判定（**完全确定性，不调 judge**）：
 *   · `violation` —— 正文真的碰到红线（凭据 / 资金 / 不可逆）。
 *   · `compliant` —— 没碰红线，且正文里有门禁或读回证据。
 *   · `unknown`   —— 没碰红线，但也没有任何门禁/读回证据 —— **不放行**（fail-closed）。
 *
 * 为什么第三种是 unknown 而不是 compliant：不碰红线只说明「没犯规」，不等于「验证过合规」。
 * 把「没提到违规」当成「合规」就是拿沉默当证据 —— 那正是 judge 误判的同一个错。
 */
export function complianceOfText(text) {
  const source = String(text ?? '')
  const redLine = hitRedLineInText(source)
  // `evidenceHit`：正文里是否出现可识别的门禁/读回证据词。
  // **只做留痕**（2026-10-12 值守裁定）：判定结果与护栏一律不动 —— 它只用来在
  // decisions.jsonl 里把「缺证据」与「踩红线」分列，便于事后一眼看出被哪一条绊倒。
  GATE_EVIDENCE.lastIndex = 0
  const evidenceHit = GATE_EVIDENCE.test(source)
  if (redLine) return { choice: 'violation', redLine, evidenceHit }
  if (evidenceHit) return { choice: 'compliant', redLine: null, evidenceHit }
  return { choice: 'unknown', redLine: null, evidenceHit }
}

/**
 * 把判定折成结果。
 *
 * 通过条件（**两条同时成立**）：
 *   完成轴 = 'accept_complete' 且 合规轴 = 'compliant'
 *
 * 只有三类会离开「继续跑」这条主路径：
 *   · `violation`     —— 红线命中：交人（合规不得自动降级，也不得靠继续跑来洗白）
 *   · `indeterminate` —— 完成轴 indeterminate / 合规 unknown / 评估不可用：交人（fail-closed）
 *   · `complete`      —— 两条全过：唯一的正常终点
 */
export function verdictFromAnswers(answers = null, { compliance = null } = {}) {
  if (!answers || typeof answers !== 'object') {
    return {
      done: false, verdict: 'indeterminate', complete: null, compliant: compliance?.choice ?? null,
      reason: 'evaluator-unavailable', missing: null,
    }
  }
  const complete = answers.complete?.choice ?? null
  const compliant = compliance?.choice ?? 'unknown'

  if (compliant === 'violation') {
    return { done: false, verdict: 'violation', complete, compliant, reason: 'compliance-violation', missing: null }
  }
  if (complete === 'accept_complete' && compliant === 'compliant') {
    return { done: true, verdict: 'complete', complete, compliant, reason: 'evidence-and-compliance-confirmed', missing: null }
  }
  if (complete !== 'accept_complete' && complete !== 'continue_work') {
    return { done: false, verdict: 'indeterminate', complete, compliant, reason: 'evidence-not-in-state', missing: null }
  }
  if (compliant === 'unknown') {
    return { done: false, verdict: 'indeterminate', complete, compliant, reason: 'no-compliance-evidence', missing: 'compliance' }
  }
  return {
    done: false,
    verdict: 'incomplete',
    complete,
    compliant,
    reason: 'required-work-remains',
    missing: 'required-work',
  }
}

/**
 * 跑一次评估人格。askJudge 由 host.js 注入（那里已统一处理超时、故障注入与用量归一化）。
 *
 * 合规轴**不调 judge**：由 `complianceOfText` 确定性判定（红线命中 / 门禁读回证据）。
 *
 * @returns `{ ...verdict, detail }`；任何异常都不抛给调用方（评估失败 = 不放行）。
 */
export async function evaluateSession(askJudge, { task, completionClaim, evidence, sessionId } = {}) {
  const profile = loadEvaluationProfile()
  const state = buildEvaluationState({ task, completionClaim, evidence, sessionId })
  const questions = buildEvaluationQuestions(profile)
  let raw = null
  try {
    raw = await askJudge(state, questions)
  } catch {
    raw = null
  }
  const compliance = complianceOfText([task, completionClaim, evidence].filter(Boolean).join('\n'))
  const verdict = verdictFromAnswers(raw?.answers ?? null, { compliance })
  return {
    ...verdict,
    persona: profile.persona ?? null,
    detail: {
      answers: raw?.answers ?? null,
      judgeUsage: raw?.usage ?? null,
      compliance,
      taskChars: state.original_task?.length ?? 0,
      claimChars: state.completion_claim?.length ?? 0,
    },
  }
}
