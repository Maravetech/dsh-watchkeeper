// judge 值守 —— 约束回流门（反思 → 判断的**消费端**）
//
// ## 为什么需要它
//
// `an external producer` 每天从 `decisions.jsonl` 提炼负向约束，
// written to a constraints file the engine optionally reads. Measured on 2026-10-05:
// 那个文件**只有生成器自己引用** —— 门禁、路由、判定层没有一处读它。
// 后果在流水里看得见：同一个问题 18:32 判「转人工」，18:33 又判「自动放行」。
// 反思写了没人用，等于没反思（本次迭代要闭合的那一环）。
//
// ## 三条设计纪律（避免「回流门」变成「一停全停」）
//
// 1. **不替 judge 做判断，只给判断补证据**：命中不稳定约束时，正确动作是
//    「要求补上一条缺失证据再判」，而不是直接把人拦在门口。
// 2. **表述里不出现红线词**：第三档描述若含「提交/发布/付款/删除」等词面，
//    值守开箱子会被判强制转人工（jev.md §10.1 实测）。本模块的文案只用「等人确认」。
// 3. **默认影子，不默认拦**：准入开关是 `WATCHKEEPER_CONSTRAINT_GATE=on`；
//    未设时只留痕（decisions.jsonl 增加 `constraintGate` 字段）不改变任何判定结果。
//    理由：改判定层会影响「值守自动作答率」这条已跑通的链路，必须先用真实样本对账再放行。
//
// ## 判定三态
//
//   allow        —— 没问题（含：约束表缺失 / 问题识别为占位问题 / 该约束仍在观察期）
//   ask-evidence —— 命中**不稳定**约束（同问题历史上既失败又成功）：要求补齐缺失证据
//   hold         —— 命中**已固化**负向约束（只失败过、证据稳定）：不自动作答，交人
//
// 「不稳定」而不是直接拦截，是因为实测数据里同题翻转的主要原因有两个：
//   ① 第二次带上了第一次缺的上下文证据（这是好事，说明补证据确实能收敛）；
//   ② 提问本身是占位问题（「请确认下一步决策」），没有可判语义。
// 把 ① 变成「补证据再判」、把 ② 单列为质量项，才不会一边收紧一边误伤。

import { createHash } from 'node:crypto'
import { FILES, stateDir } from './paths.js'
import { readJson, withFileLock, writeJsonAtomic, summarize } from './store.js'

/** 约束表路径（唯一真源在经验 Agent 的产物目录，本模块只读）。 */
export function constraintsFile() {
  const override = process.env.WATCHKEEPER_CONSTRAINTS
  if (override) return override
  // Optional file; when it is absent the gate stays open.
  return `${stateDir()}/negative_constraints.json`
}

/** 影子留痕文件（本机态；与 decisions.jsonl 同目录，便于一起归档）。 */
export function shadowFile() {
  return `${stateDir()}/constraint-shadow.json`
}

/** 准入开关：`on` / `enforce` 才真的影响判定；其它一切取值（含未设）＝影子。 */
export function gateMode() {
  const raw = String(process.env.WATCHKEEPER_CONSTRAINT_GATE ?? '').trim().toLowerCase()
  if (raw === 'enforce') return 'enforce'
  if (raw === 'on' || raw === '1' || raw === 'true') return 'gate'
  return 'shadow'
}

// ---------------------------------------------------------------- 归一化与占位识别

/**
 * 问题归一化：只保留语义骨架。
 *
 * 数字一律折成 `N`（「毛利率 41.2%」与「毛利率 38.5%」是同一个判断场景，
 * 不该因为数值不同就当成两件事）；标点与空白去掉。
 * 归一化键 = **反思层与判断层之间的公共坐标系**：两边算出的键必须一致，
 * 否则约束永远命不中 —— 这是本模块唯一的对外契约，改动即破坏兼容。
 */
export function normalizeQuestion(text) {
  let out = String(text ?? '').replace(/\s+/g, '')
  out = out.replace(/\d+(?:\.\d+)?%?/g, 'N')
  out = out.replace(/[，,。.？?！!、；;：:（）()\[\]【】{}「」“”"'’‘~～\-—_/\\|]/g, '')
  return out
}

/**
 * 占位问题模板：这些问句不含**可判语义**（问的是「下一步干嘛」，
 * 而不是「这件事该不该做」），因此不能拿它当负向约束的依据 ——
 * 否则一条「严禁自动执行：请确认下一步决策」会把所有会话的正常推进全部拦死。
 * 实测：该类问句在 781 条流水里占 588 条。
 */
export const PLACEHOLDER_QUESTIONS = [
  '请确认下一步决策',
  '接下来要跑哪一个',
  '下一步推进哪一档',
  '下一步做什么',
  '下一步做哪一件',
  '请确认下一步',
  '接下来做什么',
]

/**
 * 路由型提问：问「跑哪个 / 选哪个」的**导航问题**，不是「这件事该不该做」。
 *
 * 为什么要单独一类：实测 NEG-001「接下来要跑哪一个」失败 2 次、成功 1 次，
 * 按「无成功反例即可入门禁」会被判成 enforceable —— 一旦准入，日常推进就会平白多摩擦。
 * 它本来就不是约束对象，是**提问措辞**问题。判据与 experience-ops.py 的
 * `ROUTING_PREFIXES` 逐字一致（改一处必须改两处）。
 */
export const ROUTING_PREFIXES = [
  '接下来要跑哪', '接下来跑哪', '接下来做哪', '下一步走哪', '先跑哪', '跑哪一个', '做哪一件', '选哪一档',
]

/** 路由型提问识别 —— 前缀命中即算（归一化后比对）。 */
export function isRoutingQuestion(text) {
  const key = normalizeQuestion(text)
  return ROUTING_PREFIXES.some((p) => key.includes(normalizeQuestion(p)))
}

/** 问题字符二元组集合（中文短句用 2-gram 足够稳，不需要分词依赖）。 */
function bigrams(text) {
  const set = new Set()
  const s = String(text ?? '')
  if (s.length === 1) set.add(s)
  for (let i = 0; i + 1 < s.length; i += 1) set.add(s.slice(i, i + 2))
  return set
}

/**
 * 是否占位问题：模板短语命中，或与某模板的 2-gram 相似度过线。
 *
 * 为什么要相似度而不是只用包含判断：实测变体很多（「阶梯底线落地后，下一步做哪一件（均为本机可逆动作）？」
 * 这类句子里嵌着模板短语但还有别的内容），只做包含会漏。
 * 阈值 0.6 是**故意偏保守**：宁可漏判成实质问题（那只是多拦一次），
 * 不可把实质问题误判成占位（那会放过真正的约束）。
 */
export function isPlaceholderQuestion(text, { similarity = 0.6 } = {}) {
  const key = normalizeQuestion(text)
  if (!key) return true
  if (PLACEHOLDER_QUESTIONS.some((tpl) => key.includes(normalizeQuestion(tpl)))) return true
  const a = bigrams(key)
  if (a.size === 0) return true
  for (const tpl of PLACEHOLDER_QUESTIONS) {
    const b = bigrams(normalizeQuestion(tpl))
    let hit = 0
    for (const g of a) if (b.has(g)) hit += 1
    const union = a.size + b.size - hit
    if (union > 0 && hit / union >= similarity) return true
  }
  return false
}

// ---------------------------------------------------------------- 口径哈希

/**
 * 口径哈希：问题 + 选项集 + 证据指纹 → 短哈希。
 *
 * 「同一个问题、同一套选项、同样的证据」= 同一个判断；三者任一变化都算新判断。
 * 这是「不重复问第二次」的机器判据（值守自己的 `fingerprintOf` 带 sessionId，
 * 跨会话不复用；口径哈希刻意**不带会话**，因为反思要看的正是跨会话的一致性）。
 */
export function calibrationHash(digest) {
  const payload = JSON.stringify({
    q: normalizeQuestion(digest?.question),
    o: (Array.isArray(digest?.options) ? digest.options : []).map((x) => String(x)).sort(),
    c: createHash('sha1')
      .update(String(digest?.evidence ?? digest?.context ?? ''))
      .digest('hex')
      .slice(0, 12),
  })
  return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------- 约束表生成与读取

const UNGATEABLE_REASONS = new Set(['placement', 'red-line-repeat', 'routing-question'])
const PLACEHOLDER_REASONS = new Set(['placeholder-question'])

/**
 * 从「错误账本 + 成功账本」生成带适用面的约束表。
 *
 * 每条规则必须回答三个问题，否则不许进运行门禁：
 *   ① 什么条件下适用（applicability：观测到几次、是否有反例）
 *   ② 命中了该做什么（disposition）
 *   ③ 什么时候失效（expires_at / review：反思结论必须会过期，否则会越跑越僵）
 *
 * 分类（实测数据驱动，见 2026-10-05 台账）：
 *   · placeholder-question —— 占位问题：只做质量项，不进门禁
 *   · unstable             —— 同问题历史上有成功反例：**要求补证据**，不拦死
 *   · red-line-repeat      —— 红线重复触发：门禁管不了它（该收敛的是提问措辞）
 *   · enforceable          —— 只失败过、证据稳定：可进硬门禁
 */
export function buildConstraints(errors, successes, { generatedAt = new Date().toISOString(), windowDays = 30 } = {}) {
  const pos = new Map()
  for (const s of successes ?? []) {
    const key = normalizeQuestion(s?.scenario)
    if (!key) continue
    pos.set(key, (pos.get(key) ?? 0) + 1)
  }

  // 同一个归一化问题在错误账本里可能有多条（不同 failure_reason），合并成一条约束：
  // 运行时要的是「这个问题怎么处置」，不是「它失败过几次不同的原因」。
  const merged = new Map()
  for (const e of errors ?? []) {
    const key = normalizeQuestion(e?.trigger_question)
    if (!key) continue
    const cur = merged.get(key) ?? { key, samples: [], reasons: new Set() }
    cur.samples.push(e)
    cur.reasons.add(String(e?.failure_reason ?? 'unknown'))
    merged.set(key, cur)
  }

  const rules = []
  let seq = 0
  for (const { key, samples, reasons } of merged.values()) {
    seq += 1
    const first = samples[0]
    const placeholder = isPlaceholderQuestion(first?.trigger_question)
    const routing = isRoutingQuestion(first?.trigger_question)
    const positives = pos.get(key) ?? 0
    const redLine = [...reasons].some((r) => r.startsWith('red-line'))

    let reason
    if (placeholder) reason = 'placeholder-question'
    else if (routing) reason = 'routing-question'
    else if (redLine) reason = 'red-line-repeat'
    else if (positives > 0) reason = 'unstable'
    else reason = 'enforceable'

    rules.push({
      id: `NEG-${String(seq).padStart(3, '0')}`,
      trigger_question: first?.trigger_question ?? null,
      normalized_key: key,
      failure_reasons: [...reasons],
      category: first?.category ?? 'guardrail_or_stall',
      // 结构化负向规则：不是「禁止做 X」这一句话，而是「在什么前提下禁止」
      negative_rule: {
        forbid: first?.negative_rule ?? null,
        precondition: '在缺少本条规则所列证据时，不得自动判定为可推进',
        allowed_when: '补齐缺失证据且判定层给出高置信结论时允许恢复自动推进',
        evidence_required: samples.map((s) => summarize(s?.context_sample ?? '', 120)).filter(Boolean).slice(0, 3),
      },
      applicability: {
        question: first?.trigger_question ?? null,
        require_context: reason === 'unstable',
        scope: 'session-agnostic',
      },
      evidence: {
        neg_samples: samples.length,
        pos_samples: positives,
        first_seen: samples.map((s) => s?.recorded_at).filter(Boolean).sort()[0] ?? null,
        last_seen: samples.map((s) => s?.recorded_at).filter(Boolean).sort().slice(-1)[0] ?? null,
        sample_ids: samples.map((s) => s?.id).filter(Boolean),
      },
      disposition: reason === 'enforceable'
        ? { on_hit: 'hold', reason: 'negative-constraint-enforceable' }
        : reason === 'unstable'
          ? { on_hit: 'ask-evidence', reason: 'negative-constraint-unstable' }
          : { on_hit: 'observe', reason: `negative-constraint-${reason}` },
      gateable: !UNGATEABLE_REASONS.has(reason) && !PLACEHOLDER_REASONS.has(reason),
      reason,
      // 会过期：默认观察窗 windowDays 天；到期后必须用**新样本**重新提炼
      expires_at: new Date(Date.parse(generatedAt) + windowDays * 86_400_000).toISOString(),
      review: '样本过期后由 experience-ops 重新提炼；无新样本则降级为 observe',
    })
  }

  const by = (r) => rules.filter((x) => x.reason === r).length
  const total = rules.length || 1
  return {
    version: '2.0',
    generated_at: generatedAt,
    updated_at: generatedAt,
    total_rules: rules.length,
    source: 'an external producer（唯一生成者）',
    contract: {
      normalized_key: '两侧共用；改动即破坏兼容（见 constraint-gate.js normalizeQuestion）',
      gateable: '只有 gateable=true 的规则允许影响判定；其余仅留痕',
      expiry_days: windowDays,
    },
    rules_by_category: {
      imagery: [
        '出图严禁使用长条图强行拉伸或放大 1.3 倍，避免标签文字模糊 (HAIR REMOVAL 糊化)',
        '提示词禁止超过 100 词导致输入框截断写入失败',
        '白底商品图主体必须居中且边距充足，禁止切除瓶盖与标签边缘',
      ],
      guardrail_redlines: [
        '前两档推荐选项严禁出现发布、提交审核、投流、付款、删除字眼，防强制转人工',
        '遇资金、凭据与实名动作，必须交由店主分身 a reply provider 或转人工确认',
      ],
      runtime_locks: [
        '遇 session/writer-held 锁冲突必须自动退避 1.5 秒重试，禁止直接退出中断会话',
      ],
    },
    rules,
    // 向后兼容：旧消费方（人读、技能引用）仍能取到 itemized_lessons
    quality: {
      rules_total: rules.length,
      gateable: rules.filter((r) => r.gateable).length,
      unstable: by('unstable'),
      placeholder_questions: by('placeholder-question'),
      routing_questions: by('routing-question'),
      red_line_repeat: by('red-line-repeat'),
      enforceable: by('enforceable'),
      // 「不可入门的比例」是**提问质量**的机器指标，不是判断层的锅
      ungateable_ratio: Number(((rules.length - rules.filter((r) => r.gateable).length) / total).toFixed(3)),
    },
    itemized_lessons: rules.map((r) => ({
      id: r.id,
      rule: r.negative_rule.forbid,
      reason: r.reason,
      gateable: r.gateable,
    })),
  }
}

/** 读约束表；缺失/损坏一律返回 null（**不抛**：插件不得因读不到约束而报错）。 */
export function loadConstraints(file = constraintsFile()) {
  const data = readJson(file, null)
  if (!data || !Array.isArray(data.rules)) return null
  return data
}

// ---------------------------------------------------------------- 判定

/**
 * 对一次提问做约束回流判定。
 *
 * @returns `{ verdict, reason, rule, requiredEvidence, message, mode }`
 *   verdict: `allow` | `ask-evidence` | `hold`
 */
export function evaluateConstraint(question, { file = constraintsFile(), mode = gateMode(), now = Date.now() } = {}) {
  const base = { verdict: 'allow', reason: 'no-constraint', rule: null, requiredEvidence: null, message: null, mode }
  const table = loadConstraints(file)
  if (!table) return { ...base, reason: 'constraint-table-missing' }

  const key = normalizeQuestion(question)
  if (!key) return { ...base, reason: 'empty-question' }
  if (isPlaceholderQuestion(question)) return { ...base, reason: 'placeholder-question' }
  if (isRoutingQuestion(question)) return { ...base, reason: 'routing-question' }

  const rule = table.rules.find((r) => r.normalized_key === key)
    // 兜底：文本包含（归一化后一方含另一方），兼容标点/前缀微差
    ?? table.rules.find((r) => r.normalized_key && key.length >= 6 && (key.includes(r.normalized_key) || r.normalized_key.includes(key)))
  if (!rule) return { ...base, reason: 'no-matching-rule' }
  if (!rule.gateable) return { ...base, rule, reason: `not-gateable:${rule.reason}` }
  if (rule.expires_at && Date.parse(rule.expires_at) <= now) {
    return { ...base, rule, reason: 'rule-expired' }
  }

  const onHit = rule.disposition?.on_hit ?? 'observe'
  if (onHit === 'hold') {
    return {
      verdict: 'hold',
      reason: 'negative-constraint-enforceable',
      rule,
      requiredEvidence: rule.negative_rule?.evidence_required ?? [],
      message: `命中已固化负向约束 ${rule.id}：此前同类提问在同一口径下均未获自动推进，本轮交人确认`,
      mode,
    }
  }
  if (onHit === 'ask-evidence') {
    return {
      verdict: 'ask-evidence',
      reason: 'negative-constraint-unstable',
      rule,
      requiredEvidence: rule.negative_rule?.evidence_required ?? [],
      message: `命中不稳定约束 ${rule.id}：同一提问历史上既被拦又被放行（正/反样本 ${rule.evidence.pos_samples}/${rule.evidence.neg_samples}），本轮需先补齐证据再判`,
      mode,
    }
  }
  return { ...base, rule, reason: `observe-only:${rule.reason}` }
}

// ---------------------------------------------------------------- 影子留痕

function emptyShadow() {
  return { version: 1, updated_at: new Date().toISOString(), hits: 0, held: 0, evidence_asked: 0, by_rule: {}, by_question: {}, shadowed_auto_answers: 0 }
}

/** 读影子账本；损坏或缺失返回空账本（不抛）。 */
export function readShadow(file = shadowFile()) {
  const data = readJson(file, null)
  if (!data || typeof data !== 'object') return emptyShadow()
  return { ...emptyShadow(), ...data }
}

/**
 * 记录一次影子命中（**只留痕，绝不改变判定结果**）。
 *
 * 为什么要单独记账：放行前必须能回答「这道门到底挡了多少、挡对没挡对」。
 * `shadowed_auto_answers` 就是「如果准入会少自动几次」的直接读数 ——
 * 影子期结束时的准入决定应当由这个数字支撑，而不是拍脑袋。
 */
export function recordShadow(gateResult, outcome, { file = shadowFile(), now = Date.now() } = {}) {
  if (!gateResult || gateResult.verdict === 'allow') return null
  return withFileLock('constraint-shadow', () => {
    const book = readShadow(file)
    book.hits += 1
    if (gateResult.verdict === 'hold') book.held += 1
    if (gateResult.verdict === 'ask-evidence') book.evidence_asked += 1
    const id = gateResult.rule?.id ?? 'unknown'
    book.by_rule[id] = (book.by_rule[id] ?? 0) + 1
    const q = summarize(gateResult.rule?.trigger_question ?? '', 60)
    book.by_question[q] = (book.by_question[q] ?? 0) + 1
    if (outcome === 'auto') book.shadowed_auto_answers += 1
    book.updated_at = new Date(now).toISOString()
    writeJsonAtomic(file, book)
    return book
  })
}

/**
 * 影子对账报告：把「挡了多少」翻译成准入决策要看的两句话。
 *
 * @returns `{ hits, shadowed_auto_answers, auto_rate_cost, ready_to_enforce, note }`
 */
export function shadowReport({ file = shadowFile(), autoAnswers = null } = {}) {
  const book = readShadow(file)
  const cost = autoAnswers && autoAnswers > 0
    ? Number((book.shadowed_auto_answers / autoAnswers).toFixed(4))
    : null
  const ready = book.hits >= 20 && book.shadowed_auto_answers >= 1
  return {
    hits: book.hits,
    held: book.held,
    evidence_asked: book.evidence_asked,
    shadowed_auto_answers: book.shadowed_auto_answers,
    auto_rate_cost: cost,
    by_rule: book.by_rule,
    ready_to_enforce: ready,
    note: ready
      ? '影子样本已够：可审阅 by_rule 后决定是否置 WATCHKEEPER_CONSTRAINT_GATE=on'
      : `影子样本不足（hits=${book.hits}，建议 ≥20 且至少 1 次命中会自动判定），继续观察`,
  }
}
