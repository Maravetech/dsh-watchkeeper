// 人工问题卡：选项按钮与「没登记上要说出原因」的口径（the operator 2026-10-28）。
// 只测纯函数与登记读回，不起真端口、不碰真库。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { cardProblems, humanQuestions, normalizeOptions, validateHumanQuestion } from '../lib/human-questions.js'
import { awaitingView, createFeature, defaults, PROMPT_SECTION, shouldInjectCardPrompt } from '../lib/features/answers.js'
import { openStore } from '../lib/store.js'

const item = changes => ({
  question_id: 'memory-verdict', question: '两轮改进都没超过 grep，怎么定？', type: '卡点',
  reason: '两轮都没达标，散落地只能你定', manual_reason: '设计机制', blocking_scope: '只影响经验库走向',
  attempts: ['换了索引来源，召回没变好', '限制分块后仍不如 grep'],
  background: '两轮盲测 MemPalace 都没有一条 grep 找不到的线索。', recommendation: '如实定论，不做经验库',
  state: 'needs_user', audience: 'human', requires_user_response: true, agent_can_resolve: false, already_resolved: false,
  ...changes,
})
const card = payload => '[DECISION_POINT] ' + JSON.stringify(payload) + ' [/DECISION_POINT]'
const human = payload => card({ audience: 'human', requires_user_response: true, human_review: [payload] })

test('本人待答卡的隐藏脚注仍能登记，提示不得教模型展示英文 JSON', () => {
  const hidden = `**决策点** 怎么定？\n\n- ① 推荐：按甲\n- ② 容错：按乙\n- ③ 暂停：先停\n\n[^dp]: ${human(item({ options: ['按甲', '按乙', '先停'] }))}`
  assert.equal(humanQuestions(hidden).length, 1)
  assert.deepEqual(cardProblems(hidden), [])
  assert.match(PROMPT_SECTION.text, /unreferenced Markdown footnote definition/)
  assert.doesNotMatch(PROMPT_SECTION.text, /PLAIN message text|Before the card/)
})

test('选项：2–4 个短句才收，推荐项原顺序保留', () => {
  const options = ['如实定论，不做经验库', '再给一次机会', '先把库封存']
  assert.deepEqual(normalizeOptions(options), options)
  assert.equal(normalizeOptions(undefined), undefined)
  assert.throws(() => normalizeOptions('只有一个')) // 不是数组
  assert.throws(() => normalizeOptions(['只有一个']))
  assert.throws(() => normalizeOptions(['a', 'b', 'c', 'd', 'e']))
  assert.throws(() => normalizeOptions(['a', 'x'.repeat(121)]))
  const [question] = humanQuestions(human(item({ options })))
  assert.deepEqual(question.options, options, '选项要活到登记对象里，界面才有点的按钮')
  const degraded = humanQuestions(human(item({ options: ['只有一个'] })))
  assert.equal(degraded.length, 1, '选项写坏只丢按钮，问题本身不能跟着消失')
  assert.equal(degraded[0].options, undefined)
})

test('没登记上要说原因：代码块 / 缺包壳 / 字段不符', () => {
  const good = human(item({ options: ['按 A', '按 B'] }))
  assert.equal(humanQuestions(good).length, 1)
  assert.deepEqual(cardProblems(good), [], '登记成功的卡不报问题')

  // 截图里那种：包在 json 代码块里
  assert.deepEqual(cardProblems('结论说完，下面给卡：\n\n```json\n' + JSON.stringify({ type: 'DECISION_POINT', audience: 'human', requires_user_response: true, human_review: [item()] }) + '\n```'), ['卡被包在代码块里，界面不会显示（代码块里的卡按示例跳过）'])

  // 裸 JSON：没有 [DECISION_POINT] 包壳
  assert.deepEqual(cardProblems('直接摆一段：\n' + JSON.stringify({ audience: 'human', requires_user_response: true, human_review: [item()] })), ['缺 [DECISION_POINT] … [/DECISION_POINT] 包壳，界面收不到这条问题'])

  // 包壳在、字段不符契约
  const wrong = card({ audience: 'human', requires_user_response: true, human_review: [{ id: 'final_call', header: '定论', question: '怎么定？', options: ['A', 'B'] }] })
  assert.equal(humanQuestions(wrong).length, 0)
  assert.equal(cardProblems(wrong).length, 1)

  // 值守卡（audience=watch）格式对，不归待答报错
  assert.deepEqual(cardProblems(card({ audience: 'watch', requires_user_response: false, question: '继续吗？', options: ['继续', '停'] })), [])
  // 普通文字不报
  assert.deepEqual(cardProblems('没有问题，只是汇报进度。'), [])
})

test('待答席把选项一起送出去，界面才有点的按钮', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watchkeeper-card-'))
  const store = await openStore(path.join(dir, 'runtime.db'))
  try {
    const options = ['如实定论', '再试一次', '先封存']
    const [question] = humanQuestions(human(item({ options })))
    store.add({ sessionId: 'session-a', task: '经验库治理', messageId: 'm1', quote: '两轮盲测', question: question.question, human: question })
    const view = awaitingView(store, new Map(), 'session-a')
    assert.equal(view.length, 1)
    assert.deepEqual(view[0].options, options)
    assert.match(view[0].question, /怎么定/)
    assert.equal(validateHumanQuestion(question).contract_version, 1)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('路由层：卡没登记上时接口当场返回原因（不用重启也能测到接线）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watchkeeper-route-'))
  const event = { seq: 9, type: 'assistant/message', data: { content: [{ type: 'text', text: '结论说完。\n\n```json\n' + JSON.stringify({ type: 'DECISION_POINT', audience: 'human', requires_user_response: true, human_review: [item()] }) + '\n```' }] } }
  const compat = {
    core: dir,
    on: () => () => {},
    whenService: (name, callback) => { if (name === 'sessionController') callback({ inspect: async () => ({ events: [event] }) }) },
    readBody: async req => req.body,
  }
  const feature = createFeature({ compat, config: { dbPath: path.join(dir, 'runtime.db') }, log: () => {} })
  try {
    feature.start()
    for (let i = 0; i < 100 && !feature.state().ok; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(feature.state().ok, true, '存储要能起在临时目录')
    const body = JSON.stringify({ sessionId: 'session-a', seq: 9 })
    const reply = () => ({ headers: {}, setHeader() {}, end(payload) { this.payload = payload } })
    const conf = reply()
    await feature.handle({ method: 'GET', headers: { host: '127.0.0.1' } }, conf, 'answers/config', new URL('http://127.0.0.1/watchkeeper/answers/config'))
    const { token } = JSON.parse(conf.payload)
    assert.ok(token, '令牌可从 config 拿到（与页面注入同一枚）')
    const res = reply()
    await feature.handle({ method: 'POST', headers: { host: '127.0.0.1', origin: '', 'x-watchkeeper-token': token }, body }, res, 'answers/message', new URL('http://127.0.0.1/watchkeeper/answers/message'))
    const parsed = JSON.parse(res.payload)
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.data.items, [])
    assert.deepEqual(parsed.data.problems, ['卡被包在代码块里，界面不会显示（代码块里的卡按示例跳过）'])
  } finally {
    feature.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('卡片提示默认不注入（the operator 2026-10-29：值守已关，别再每轮逼着出卡）', () => {
  assert.equal(defaults.cardPrompt, false, '默认必须关')
  assert.equal(shouldInjectCardPrompt({}), false)
  assert.equal(shouldInjectCardPrompt({ enabled: true }), false)
  assert.equal(shouldInjectCardPrompt({ cardPrompt: true }), true)
})

test('显式开启提示时，卸载插件必须注销系统提示段', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watchkeeper-prompt-'))
  let registered = 0
  let removed = 0
  const compat = {
    core: dir,
    on: () => () => {},
    whenService: (name, callback) => {
      if (name === 'systemPrompt') callback({ section: () => { registered++; return () => { removed++ } } })
    },
  }
  const feature = createFeature({ compat, config: { cardPrompt: true, dbPath: path.join(dir, 'runtime.db') }, log: () => {} })
  feature.start()
  assert.equal(registered, 1)
  feature.dispose()
  assert.equal(removed, 1)
  rmSync(dir, { recursive: true, force: true })
})
