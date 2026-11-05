// 待答事项的存储（SQLite）—— 与旧 session-review 同一张库、同一套表结构，便于平滑接续。
//
// 表：session_review_items（事项）/ session_review_batches（批次）。schema 与字段语义保持不变，
// 引擎换成 watchkeeper 之后历史事项照旧读得到（兼容优先于好看）。

import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
export const digest = value => createHash('sha256').update(value).digest('hex')
export function bounded(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(label + '为空或过长')
  return value
}
export async function openStore(file) {
  const { DatabaseSync } = await import('node:sqlite')
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS session_review_items (id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS session_review_batches (id TEXT PRIMARY KEY, data TEXT NOT NULL);')
  db.exec("CREATE INDEX IF NOT EXISTS session_review_scope ON session_review_items(json_extract(data,'$.sessionId'),json_extract(data,'$.kind'));")
  const read = id => { const row = db.prepare('SELECT data FROM session_review_items WHERE id=?').get(id); if (!row) throw Error('事项不存在'); return JSON.parse(row.data) }
  const write = row => db.prepare('UPDATE session_review_items SET data=? WHERE id=?').run(JSON.stringify(row), row.id)
  const batch = id => { const row = db.prepare('SELECT data FROM session_review_batches WHERE id=?').get(id); return row && JSON.parse(row.data) }
  const writeBatch = row => db.prepare('INSERT OR REPLACE INTO session_review_batches VALUES (?,?)').run(row.id, JSON.stringify(row))
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result } catch (err) { db.exec('ROLLBACK'); throw err } }
  return {
    close: () => db.close(),
    list(sessionId, view = 'all') {
      const where = [], params = []
      if (sessionId) { where.push("json_extract(data,'$.sessionId')=?"); params.push(sessionId) }
      if (view === 'annotations') where.push("json_extract(data,'$.kind')='annotation'")
      if (view === 'questions' || view === 'awaiting') where.push("json_extract(data,'$.kind')='question' AND json_extract(data,'$.human.contract_version')=1")
      if (view === 'awaiting') where.push("json_extract(data,'$.human.state')='needs_user' AND json_extract(data,'$.status') NOT IN ('已完成','已解决','已取代','已归档') AND (json_extract(data,'$.status')='需补充' OR json_extract(data,'$.submittedVersion')<json_extract(data,'$.version'))")
      const query = 'SELECT data FROM session_review_items' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY rowid DESC LIMIT 1000'
      return db.prepare(query).all(...params).map(x => JSON.parse(x.data))
    },
    get: read, batch,
    updateTask(sessionId, task) { return tx(() => { for (const row of this.list(sessionId)) { row.task = task.slice(0, 120); write(row) } }) },
    add(input) {
      const sessionId = bounded(input.sessionId, 256, '会话'), quote = bounded(input.quote, 20000, '原文')
      const question = bounded(input.question, 4000, '问题'), messageId = String(input.messageId ?? '')
      const key = digest(JSON.stringify(input.human ? [sessionId, 'human', input.human.question_id] : [sessionId, messageId, quote, question]))
      return tx(() => {
        const existing = db.prepare('SELECT data FROM session_review_items WHERE source_key=?').get(key)
        if (existing) {
          const row = JSON.parse(existing.data)
          if (input.human && input.human.revision > row.human?.revision) {
            row.history = [...(row.history || []), { answer: row.answer, human: row.human, status: row.status }].slice(-20)
            Object.assign(row, { human: input.human, question, quote, messageId, answer: '', version: row.version + 1, submittedVersion: -1, status: '待回答', delivery: '未提交', archived: false, receipt: '', evidence: '' }); write(row)
          } else if (input.human && messageId && !row.messageId) { row.messageId = messageId; write(row) }
          return row
        }
        const row = { id: randomUUID(), sessionId, task: String(input.task || sessionId).slice(0, 120), messageId, quote, question, kind: input.human ? 'question' : 'annotation', human: input.human || null, table: input.table || null, answer: '', version: 0, deferred: false, delivery: '未提交', status: input.human ? '待回答' : '可批注', receipt: '', evidence: '', submittedVersion: -1, createdAt: Date.now(), updatedAt: Date.now() }
        db.prepare('INSERT INTO session_review_items VALUES (?,?,?)').run(row.id, key, JSON.stringify(row)); return row
      })
    },
    migrateHumanContract() {
      return tx(() => { let changed = 0
        for (const { data } of db.prepare("SELECT data FROM session_review_items WHERE json_extract(data,'$.human') IS NULL AND json_extract(data,'$.kind')!='annotation' AND COALESCE(json_extract(data,'$.archived'),0)=0").all()) {
          const row = JSON.parse(data)
          if (row.human || row.kind === 'annotation' || row.archived) continue
          const hasAnswer = !!row.answer?.trim()
          row.legacyQuestion = row.question
          row.kind = hasAnswer ? 'annotation' : 'archived'; row.archived = !hasAnswer
          if (!hasAnswer) row.status = '已归档'
          if (/^请针对这条决策点填写回答/.test(row.question)) row.question = '原决策卡的补充意见'
          row.migration = 'human-contract-v1'; write(row); changed++
        }
        return changed
      })
    },
    resolve(sessionId, id, state, resolution, evidence) {
      return tx(() => { const row = read(id)
        if (row.sessionId !== sessionId || row.kind !== 'question' || !['resolved', 'superseded'].includes(state)) throw Error('问题关闭来源或状态不合法')
        bounded(resolution, 12000, '解决说明'); bounded(evidence, 12000, '解决证据')
        row.human.state = state; row.status = state === 'resolved' ? '已解决' : '已取代'; row.receipt = resolution; row.evidence = evidence; write(row); return row
      })
    },
    explanation(id, question, text) {
      return tx(() => { const row = read(id); bounded(question, 4000, '追问'); bounded(text, 12000, '解释')
        row.explanations = [...(row.explanations || []), { question, text, time: Date.now() }].slice(-10); write(row); return row
      })
    },
    save(id, expected, answer, deferred = false) {
      if (typeof answer !== 'string' || answer.length > 12000) throw Error('回答过长')
      return tx(() => { const row = read(id); if (row.version !== expected) throw Error('回答版本冲突，请刷新后合并')
        if (row.delivery === '发送中') throw Error('正在投递，稍后再修改')
        row.answer = answer; row.deferred = deferred; row.version++; row.updatedAt = Date.now(); write(row); return row })
    },
    prepare(sessionId, expectedItems) {
      return tx(() => {
        const rows = expectedItems.map(x => read(x.id))
        if (!rows.length || rows.length > 50 || new Set(rows.map(x => x.id)).size !== rows.length) throw Error('每批应为 1–50 个不同事项')
        rows.forEach((row, i) => {
          if (row.sessionId !== sessionId) throw Error('不能混投不同会话')
          if (row.archived || ['已完成', '已解决', '已取代', '已归档'].includes(row.status)) throw Error('已解决或归档事项不能再提交')
          if (row.version !== expectedItems[i].version) throw Error('回答版本冲突')
          if (!row.answer.trim() || row.deferred) throw Error('空白或暂缓事项不能提交')
          if (row.submittedVersion === row.version) throw Error('此版本已经提交，请查看回执')
          if (['发送中', '待核对'].includes(row.delivery)) throw Error('上次投递尚待核对，不能重复提交')
        })
        const b = { id: randomUUID(), sessionId, task: rows[0].task, requestId: 'review-' + randomUUID(), state: '发送中', createdAt: Date.now(), items: rows.map(row => ({ id: row.id, version: row.version, quote: row.quote, question: row.question, answer: row.answer })) }
        if (JSON.stringify(b).length > 120000) throw Error('本批内容过长，请分批提交')
        writeBatch(b); rows.forEach(row => { row.history = [...(row.history || []), { batchId: row.batchId || '', version: row.submittedVersion, status: row.status, receipt: row.receipt, evidence: row.evidence }].slice(-20); row.delivery = '发送中'; row.batchId = b.id; write(row) }); return b
      })
    },
    delivered(id, state, detail = '') {
      return tx(() => { const b = batch(id); if (!b) throw Error('批次不存在'); b.state = state; b.detail = detail; writeBatch(b)
        b.items.forEach(item => { const row = read(item.id); row.delivery = state; if (state === '已接收') { row.submittedVersion = item.version; if (row.receiptBatch !== id) { row.status = '待处理'; row.receipt = ''; row.evidence = '' } }; row.updatedAt = Date.now(); write(row) }); return b })
    },
    receipt(sessionId, id, batchId, status, receipt, evidence = '') {
      return tx(() => { const row = read(id), b = batch(batchId)
        if (row.sessionId !== sessionId || !b || b.sessionId !== sessionId || row.batchId !== batchId) throw Error('回执来源或批次不匹配')
        if (!['处理中', '已完成', '受阻', '需补充'].includes(status)) throw Error('回执状态不合法')
        bounded(receipt, 12000, '回执'); if (status === '已完成') bounded(evidence, 12000, '完成证据')
        row.receiptBatch = batchId; row.status = status; row.receipt = receipt; row.evidence = evidence; row.updatedAt = Date.now(); write(row); return row })
    },
    recover() {
      return tx(() => { for (const row of db.prepare('SELECT data FROM session_review_batches').all()) { const b = JSON.parse(row.data); if (b.state !== '发送中') continue
        b.state = '待核对'; writeBatch(b); b.items.forEach(item => { const x = read(item.id); x.delivery = '待核对'; write(x) }) } })
    },
  }
}
