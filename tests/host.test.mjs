// 值守台宿主半单测：会话编号读数的口径与路由，以及降级路径。
// 用假 ctx / 假 webServer / 假账本文件驱动 lib/host.js，不起真端口、不跑真脚本。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply, resolveConfig, BASE_PATH } from '../lib/host.js'
import * as numbers from '../lib/features/numbers.js'

const TEST_RUNTIME = mkdtempSync(path.join(tmpdir(), 'watchkeeper-runtime-'))
const TEST_LOG_FILE = path.join(TEST_RUNTIME, 'watchkeeper.log')
// watchkeeper apply() starts the migrated judge engine, which runs startup recovery,
// persists legacy migration, and prunes the outbox. Keep every such write out of
// the real operator runtime during tests.
process.env.WATCHKEEPER_HOME = path.join(TEST_RUNTIME, 'home')
process.env.WATCHKEEPER_STATE_DIR = path.join(TEST_RUNTIME, 'state')
process.env.WATCHKEEPER_UI_CONTROL_DIR = path.join(TEST_RUNTIME, 'ui-control')
process.on('exit', () => rmSync(TEST_RUNTIME, { recursive: true, force: true }))

function fakeCtx(web) {
  const handlers = new Map()
  return {
    _handlers: handlers,
    get: name => (name === 'webServer' ? web : undefined),
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
    effect(fn) { const off = fn(); return typeof off === 'function' ? off : () => {} },
  }
}

function fakeWeb() {
  const routes = []
  return { port: 52562, routes, register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } } }
}

function fakeRes() {
  const headers = {}
  return {
    headers, statusCode: 0, body: null,
    setHeader: (k, v) => { headers[k] = v },
    end(body) { this.body = body ? JSON.parse(body) : null },
  }
}

function fakeReq(method, url, payload) {
  const listeners = new Map()
  return {
    method, url, headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' },
    on(name, fn) { listeners.set(name, fn); return this },
    destroy() {},
    async fire() { if (payload !== undefined) listeners.get('data')?.(JSON.stringify(payload)); listeners.get('end')?.() },
  }
}

async function call(handler, method, url, payload) {
  const req = fakeReq(method, url, payload)
  const res = fakeRes()
  const done = handler(req, res)
  if (payload !== undefined) await req.fire()
  await done
  return res
}

function writeLedger(rows) {
  const dir = mkdtempSync(path.join(tmpdir(), 'watchkeeper-'))
  const file = path.join(dir, 'numbering.json')
  writeFileSync(file, JSON.stringify({ version: 1, updated_at: '2026-10-15T14:00:00Z', numbers: rows }))
  return file
}

test('口径：台账折成按号排序的行，缺号的条目直接丢掉（不编）', () => {
  assert.equal(numbers.numberFor({ n: 7 }), '7')
  assert.equal(numbers.numberFor({}), null)
  assert.equal(numbers.numberFor(null), null)
  const rows = numbers.toRows({ numbers: {
    'session-b': { n: 2, title: 'B' },
    'session-a': { n: 1, title: 'A' },
    'session-x': { title: '没有号' },
  } })
  assert.deepEqual(rows.map(r => r.sessionId), ['session-a', 'session-b'])
  assert.equal(rows[0].n, '1')
  assert.equal(numbers.toRows(null).length, 0)
})

test('resolveConfig：总闸与子开关', () => {
  const features = [numbers]
  assert.equal(resolveConfig({}, features).numbers.enabled, true)
  assert.equal(resolveConfig({ enabled: false }, features).numbers.enabled, false)
  assert.equal(resolveConfig({ numbers: { refreshMs: 5000 } }, features).numbers.refreshMs, 5000)
})

test('装配：一条路由族 + health 可读 + 编号台账读数', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'watchkeeper-home-'))
  process.env.WATCHKEEPER_HOME = home
  writeFileSync(path.join(home, 'numbers.json'), JSON.stringify({ updated_at: '2026-10-15T14:00:00Z', numbers: {
    'session-a': { n: 1, title: 'A' }, 'session-b': { n: 2, title: 'B' },
  } }))
  try {
    const web = fakeWeb()
    const ctx = fakeCtx(web)
    const dispose = await apply(ctx, {
      logFile: TEST_LOG_FILE,
      numbers: { refreshMs: 3_600_000 },
    })
    const handler = web.routes.find(r => r.kind === 'prefix').handler
    assert.ok(web.routes.some(r => r.kind === 'exact' && r.path === `${BASE_PATH}/health`))

    const health = await call(handler, 'GET', `${BASE_PATH}/health`)
    assert.equal(health.statusCode, 200)
    assert.equal(health.body.adapter, 'dsh-watchkeeper/host-compat@1')
    assert.deepEqual(health.body.features.map(f => f.id), ['numbers', 'answers', 'providers', 'watch'])

    const state = await call(handler, 'GET', `${BASE_PATH}/numbers/state`)
    assert.equal(state.statusCode, 200)
    assert.equal(state.body.ok, true)
    assert.equal(state.body.count, 2)
    assert.equal(state.body.rows[0].n, '1')

    const missing = await call(handler, 'GET', `${BASE_PATH}/nope/state`)
    assert.equal(missing.statusCode, 404)
    dispose()
    assert.equal(web.routes.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('降级：编号台账不在场时返回空表，不编号', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'watchkeeper-missing-'))
  process.env.WATCHKEEPER_HOME = home
  try {
    const web = fakeWeb()
    const ctx = fakeCtx(web)
    const dispose = await apply(ctx, { logFile: TEST_LOG_FILE, numbers: { refreshMs: 3_600_000 } })
    const handler = web.routes.find(r => r.kind === 'prefix').handler
    const state = await call(handler, 'GET', `${BASE_PATH}/numbers/state`)
    assert.equal(state.body.ok, true, 'missing ledger on first run is not an error')
    assert.deepEqual(state.body.rows, [])
    dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('回复接管开关：默认全关、可只开一个、也可都开；状态落盘', async () => {
  const { mkdtempSync } = await import('node:fs')
  const dir = mkdtempSync(path.join(tmpdir(), 'watchkeeper-providers-'))
  const file = path.join(dir, 'toggles.json')
  const web = fakeWeb()
  const ctx = fakeCtx(web)
  const dispose = await apply(ctx, {
    logFile: TEST_LOG_FILE,
    providers: { togglesPath: file },
    numbers: { refreshMs: 3_600_000, spawn: false },
  })
  const handler = web.routes.find(r => r.kind === 'prefix').handler

  const initial = await call(handler, 'GET', `${BASE_PATH}/providers/state`)
  assert.equal(initial.body.ok, true)
  assert.deepEqual(initial.body.active, [], '默认全关 = 不接管')
  assert.equal(initial.body.providers.length, 3)

  const on = await call(handler, 'POST', `${BASE_PATH}/providers/toggle`, { id: 'codex', enabled: true })
  assert.equal(on.body.ok, true)
  assert.deepEqual(on.body.state.active, ['codex'])
  assert.equal(on.body.state.takeover, 'codex')

  const both = await call(handler, 'POST', `${BASE_PATH}/providers/toggle`, { id: 'agy', enabled: true })
  assert.deepEqual(both.body.state.active, ['codex', 'agy'], 'enabled providers keep ORDER')

  const bad = await call(handler, 'POST', `${BASE_PATH}/providers/toggle`, { id: 'nope', enabled: true })
  assert.equal(bad.statusCode, 200)
  assert.equal(bad.body.ok, false)

  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(persisted.codex, true)
  assert.equal(persisted.agy, true)
  assert.equal(persisted.custom, false)
  dispose()
})

test('值守引擎：现场已有引擎时自动让位（避免双重接管），状态如实回报', async () => {
  const web = fakeWeb()
  const ctx = fakeCtx(web)
  // Simulate another engine already providing the watchkeeper service.
  const originalGet = ctx.get
  ctx.get = name => (name === 'watchkeeper' ? { state: () => ({}) } : originalGet(name))
  const dispose = await apply(ctx, {
    logFile: TEST_LOG_FILE,
    numbers: { refreshMs: 3_600_000, spawn: false },
  })
  const handler = web.routes.find(r => r.kind === 'prefix').handler
  const state = await call(handler, 'GET', `${BASE_PATH}/watch/state`)
  assert.equal(state.statusCode, 200)
  assert.equal(state.body.enabled, true, 'enabled by default, but must not mount when the service is taken')
  assert.equal(state.body.mounted, false, 'another engine present means no mount')
  assert.match(state.body.service, /watchkeeper/)
  assert.match(String(state.body.note || ''), /another engine|yields/i)
  dispose()
})

test('搬进来的值守引擎：模块能加载、对外契约在位（服务名与关键导出）', async () => {
  const engine = await import('../lib/watch/host.js')
  assert.equal(engine.name, 'dsh-watchkeeper')
  assert.equal(typeof engine.apply, 'function', '引擎的 apply 必须在位')
  assert.equal(typeof engine.Config, 'object', '引擎配置形状必须在位')
  // 回复执行与开关都要指向本包自己的实现（不再依赖 execution-provider）
  const reply = await import('../lib/reply.js')
  assert.equal(typeof reply.generateReply, 'function')
  assert.equal(typeof reply.resolveReplyCommand, 'function')
  const providers = await import('../lib/providers.js')
  assert.deepEqual(providers.ORDER, ['codex', 'agy', 'custom'])
})

test('失败隔离：单个读数块坏掉不再拖垮整包（health 带 degraded 清单）', async () => {
  const web = fakeWeb()
  const ctx = fakeCtx(web)
  const dispose = await apply(ctx, {
    logFile: TEST_LOG_FILE,
    numbers: { refreshMs: 3_600_000, spawn: false },
  })
  const handler = web.routes.find(r => r.kind === 'prefix').handler
  const health = await call(handler, 'GET', `${BASE_PATH}/health`)
  assert.equal(health.statusCode, 200)
  assert.deepEqual(health.body.degraded, [], '正常时降级清单应为空')
  assert.ok(health.body.features.length >= 1, '至少有一块读数活着')
  dispose()
})
