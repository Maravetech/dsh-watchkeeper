// 人工问题契约 v1 —— 与旧 session-review 逐字一致的判据（契约不能改：历史卡与在库事项都按它解释）。
import { readFileSync } from 'node:fs'
const schema = JSON.parse(readFileSync(new URL('../human-question.schema.json', import.meta.url), 'utf8'))
const CARD_OPEN = '[DECISION_POINT]'
const CARD_RE = /\[DECISION_POINT\]\s*(\{[\s\S]*?\})\s*\[\/DECISION_POINT\]/g
const FENCE_RE = /^(`{3,}|~{3,})/

/** 选项：2–4 个互斥短句、推荐项放第一。写错只丢按钮（不出坏按钮），问题本身照常登记。 */
export function normalizeOptions(value) {
  if (value === undefined || value === null) return undefined
  const limits = schema.options || { min: 2, max: 4, max_chars: 120 }
  if (!Array.isArray(value)) throw Error('待答选项必须是数组')
  const list = value.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  if (list.length < limits.min || list.length > limits.max) throw Error(`待答选项必须是 ${limits.min}–${limits.max} 个`)
  if (list.some(item => item.length > limits.max_chars)) throw Error('待答选项过长')
  return list
}

export function validateHumanQuestion(input) {
  if (!input || schema.required.some(key => !(key in input))) throw Error('待答缺少明确的人工登记字段')
  if (input.audience !== 'human' || input.requires_user_response !== true || input.agent_can_resolve !== false || input.already_resolved !== false || input.state !== schema.active_state) throw Error('此项不是尚待本人回答的问题')
  if (!schema.types.includes(input.type) || !schema.manual_reasons.includes(input.manual_reason)) throw Error('待答类型或人工原因不合法')
  for (const key of ['question_id', 'question', 'reason', 'blocking_scope', 'background', 'recommendation']) if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > (key === 'question_id' ? 120 : 12000)) throw Error('待答字段为空或过长：' + key)
  if (schema.placeholder_patterns.some(pattern => new RegExp(pattern).test(input.question.trim()))) throw Error('占位提示不是具体问题')
  if (!Array.isArray(input.attempts) || !input.attempts.length || input.attempts.some(x => typeof x !== 'string' || !x.trim() || x.length > 4000)) throw Error('必须说明 Agent 已尝试的方法')
  if (input.type === '冲突' && (!Array.isArray(input.conflicting_rules) || input.conflicting_rules.length < 2 || input.conflicting_rules.some(x => typeof x !== 'string' || !x.trim()))) throw Error('冲突必须列出双方原文或要求')
  // 选项只是便捷输入：写坏了就丢按钮、仍保留这条问题（问题本身不能因为按钮不合格而消失）。
  let options
  try { options = normalizeOptions(input.options) } catch { options = undefined }
  const revision = input.revision ?? 1
  if (!Number.isSafeInteger(revision) || revision < 1) throw Error('问题版本不合法')
  const normalized = { ...input, revision, contract_version: schema.contract_version }
  if (options) normalized.options = options
  else delete normalized.options
  return normalized
}
export function isAwaitingHuman(row) {
  if (row.kind !== 'question' || row.archived || ['已完成', '已解决', '已取代', '已归档'].includes(row.status)) return false
  try { validateHumanQuestion(row.human) } catch { return false }
  return row.status === '需补充' || row.submittedVersion < row.version
}

/** 只取「围栏外、非引用」的行：代码块与引用里的卡是示例，不是本轮的活问题。 */
function unfencedLines(text) {
  let fenced = ''
  const lines = []
  for (const line of text.split('\n')) {
    const mark = line.trim().match(FENCE_RE)
    if (mark) { if (!fenced) fenced = mark[1][0]; else if (fenced === mark[1][0]) fenced = ''; continue }
    if (!fenced && !line.trim().startsWith('>')) lines.push(line)
  }
  return lines
}

/** 卡里的 JSON 载荷；解析失败的记 null（用来区分「包壳坏了」与「字段坏了」）。 */
export function cardPayloads(text) {
  const result = []
  for (const match of unfencedLines(text).join('\n').slice(0, 160000).matchAll(CARD_RE)) {
    try { result.push(JSON.parse(match[1])) } catch { result.push(null) }
  }
  return result
}

export function humanQuestions(text) {
  // Do not ingest quoted/fenced examples as live declarations.
  const result = []
  for (const payload of cardPayloads(text)) {
    if (!payload) continue
    if (payload.audience !== 'human' || payload.requires_user_response !== true) continue
    const questions = Array.isArray(payload.human_review) ? payload.human_review : [payload.human_review]
    for (const q of questions.slice(0, 50)) { try { result.push(validateHumanQuestion(q)) } catch {} }
  }
  return result
}

/**
 * 「这条消息看起来出了卡，但一条都没登记」的原因（the operator 2026-10-28：生 JSON 摆在大段里，
 * 界面一点提示都没有，问题就这么丢了 —— 以后必须当场说出为什么没收）。
 * 空数组 = 要么登记成功，要么这条消息本来就没打算出人工卡（值守卡不归这里报）。
 */
export function cardProblems(text) {
  const payloads = cardPayloads(text)
  const human = payloads.filter(payload => payload && payload.audience === 'human' && payload.requires_user_response === true)
  const usable = payload => {
    const items = Array.isArray(payload.human_review) ? payload.human_review : [payload.human_review]
    return items.some(item => { try { validateHumanQuestion(item); return true } catch { return false } })
  }
  if (human.some(usable)) return []
  if (human.length) return ['卡的字段不符合人工问题契约（缺 question_id / type / manual_reason / attempts 等），界面收不到这条问题']
  if (payloads.length) return []
  let fenced = ''
  let fencedCard = false
  for (const line of text.split('\n')) {
    const mark = line.trim().match(FENCE_RE)
    if (mark) { if (!fenced) fenced = mark[1][0]; else if (fenced === mark[1][0]) fenced = ''; continue }
    if (fenced && (line.includes(CARD_OPEN) || line.includes('"human_review"') || line.includes('"DECISION_POINT"'))) fencedCard = true
  }
  if (fencedCard) return ['卡被包在代码块里，界面不会显示（代码块里的卡按示例跳过）']
  if (/"human_review"\s*:|"requires_user_response"\s*:|"type"\s*:\s*"DECISION_POINT"/.test(text)) return ['缺 [DECISION_POINT] … [/DECISION_POINT] 包壳，界面收不到这条问题']
  return []
}

export const humanParameterSchema = {
  type: 'object', required: schema.required,
  properties: {
    ...Object.fromEntries(['question_id', 'question', 'reason', 'blocking_scope', 'background', 'recommendation'].map(key => [key, { type: 'string' }])),
    type: { type: 'string', enum: schema.types }, manual_reason: { type: 'string', enum: schema.manual_reasons },
    state: { type: 'string', enum: ['needs_user'] }, audience: { type: 'string', enum: ['human'] },
    requires_user_response: { type: 'boolean', enum: [true] }, agent_can_resolve: { type: 'boolean', enum: [false] }, already_resolved: { type: 'boolean', enum: [false] },
    attempts: { type: 'array', items: { type: 'string' }, minItems: 1 }, conflicting_rules: { type: 'array', items: { type: 'string' } }, revision: { type: 'integer', minimum: 1 },
    options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
  },
}
