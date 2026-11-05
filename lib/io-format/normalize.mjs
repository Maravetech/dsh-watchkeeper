// the project 出站正文的轻量规范化（纯函数，无依赖、不注册插件）
//
// 用途：任何 Agent 生成、要送给人或下一棒的正文，在**发送前**过一遍这个函数 ——
//   ① 枚举序号（①②③…）逐条分行（统一成 `- ① …`，不带列表符会被 Markdown 合成一段、把换行吞掉）；
//   ② 超过 100 字且 ≥3 个句末标点的长段按句拆短（每 2 句一段）。
//
// 设计约束（the operator 2026-10-07 选「② 容错·降级」）：
//   · **只改格式，不拦不拒** —— 出问题时返回原文，绝不阻断消息发送；
//   · 只插入换行与空行，**不增删改任何字符**（媒体标记 `[media:…]` 这类整行标记不受影响）。
//
// 为什么机械做而不是只写在提示词里：提示词是「要求」，模型可能不照做；
// 同一条消息既是 A 的输出、又是 B 的输入，格式错了读的人就得自己拆句。
//
// 跑法（回归）：node integrations/io-format/tests/normalize.test.mjs

const ENUM_HEADS = '①②③④⑤⑥⑦⑧⑨⑩'
const ENUM_HEAD_RE = new RegExp(`^[${ENUM_HEADS}]`)
const ENUM_ANY_RE = new RegExp(`[${ENUM_HEADS}]`)
const SENTENCE_END_RE = /[。！？；]/
const SENTENCE_END_ALL_RE = /[。！？；]/g
const LONG_LINE_CHARS = 100
const MIN_SENTENCES = 3

/** 把一行按句末标点切成句子（保留标点）。 */
function splitSentences(line) {
  return line.split(/(?<=[。！？；])/).filter((s) => s.trim())
}

/**
 * 规范化正文：枚举逐条分行 + 长段拆短。纯函数，永远返回字符串。
 * @param {unknown} text 原始正文
 * @returns {string} 规范化后的正文（输入为空时返回空串）
 */
export function normalizeReplyFormat(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n').trim()
  if (!source) return ''

  // ① 序号逐条分行，并统一成项目符号列表（不带列表符会被 Markdown 合成一段、把换行吞掉）。
  //    逐行处理而不是整篇正则替换 —— 否则 `- ①…` 这种**已经分好行**的输入会被再切一刀，
  //    函数就不幂等了（回归测试锁死这条）。
  const lines = []
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^[-*+]\s+[①②③④⑤⑥⑦⑧⑨⑩]/.test(line)) {
      lines.push(line.replace(/^[*+]\s+/, '- '))          // 列表项：只统一符号，不再切
      continue
    }
    if (ENUM_HEAD_RE.test(line)) {
      lines.push(`- ${line}`)                              // 整行以序号开头：补列表符
      continue
    }
    if (!ENUM_ANY_RE.test(line)) {
      lines.push(line)                                     // 没有序号：原样
      continue
    }
    // 行中间夹序号：在每个序号前切开，切成独立条目
    for (const part of line.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/).map((s) => s.trim()).filter(Boolean)) {
      // 纯标点的残片（如「（」）不配自成一行，挂回上一条；带序号的残片照常独立
      if (!/[\w\u4e00-\u9fff①②③④⑤⑥⑦⑧⑨⑩]/.test(part) && lines.length > 0) {
        lines[lines.length - 1] += part
        continue
      }
      lines.push(ENUM_HEAD_RE.test(part) ? `- ${part}` : part)
    }
  }

  // ② 长段拆短；列表项与短行原样保留
  const paragraphs = []
  for (const line of lines) {
    if (line.startsWith('- ') || line.length <= LONG_LINE_CHARS) {
      paragraphs.push(line)
      continue
    }
    const sentences = splitSentences(line)
    if (sentences.length < MIN_SENTENCES) {
      paragraphs.push(line)
      continue
    }
    for (let i = 0; i < sentences.length; i += 2) {
      paragraphs.push(sentences.slice(i, i + 2).join('').trim())
    }
  }

  return paragraphs.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 发送前的安全包装：**只改格式，不拦不拒**。
 * 任何异常、或规范化后变成空串，都返回原文 —— 宁可不改格式，也不能丢消息。
 * @param {unknown} text 原始正文
 * @returns {string} 规范化结果或原文
 */
export function safeNormalizeReplyFormat(text) {
  try {
    const original = String(text ?? '')
    const out = normalizeReplyFormat(original)
    return out.trim() ? out : original
  } catch {
    // 连字符串化都失败的输入（几乎不可能是真实消息）：回退成原文或空串，绝不抛错
    return typeof text === 'string' ? text : ''
  }
}

/** 便于测试与排查：这一行是否会被判定为「整段不换行」的嫌疑行。 */
export function hasRunOnShape(line) {
  const text = String(line ?? '')
  const marks = [...text].filter((ch) => ENUM_ANY_RE.test(ch)).length
  return marks >= 3 || (text.length > LONG_LINE_CHARS && (text.match(SENTENCE_END_ALL_RE) ?? []).length >= MIN_SENTENCES)
}
