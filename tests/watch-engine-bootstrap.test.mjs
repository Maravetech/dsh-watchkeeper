// 覆盖值守引擎依赖 WebServer 的延迟注入，不连接 DSH 或真实会话。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const runtime = mkdtempSync(path.join(tmpdir(), 'watch-engine-bootstrap-'))
process.env.WATCHKEEPER_HOME = path.join(runtime, 'home')
process.env.WATCHKEEPER_STATE_DIR = path.join(runtime, 'state')
process.env.WATCHKEEPER_UI_CONTROL_DIR = path.join(runtime, 'ui-control')
process.on('exit', () => rmSync(runtime, { recursive: true, force: true }))

const { createFeature } = await import('../lib/features/watch.js')

test('WebServer 延迟就绪后再挂载值守引擎，不因空注入使整块失败', async () => {
  const cleanups = []
  const events = new Map()
  const ctx = {
    get() { return undefined },
    inject(names) {
      assert.equal(names.includes('webServer'), false, 'watchkeeper 应传入适配层已就绪的服务')
      return () => {}
    },
    on(name, fn) { events.set(name, fn); return () => events.delete(name) },
    effect(fn) {
      const off = fn()
      if (typeof off === 'function') cleanups.push(off)
      return () => {}
    },
  }
  const logs = []
  let onWebServer
  let cancelled = false
  const compat = {
    ctx,
    whenService(name, callback) {
      assert.equal(name, 'webServer')
      onWebServer = callback
      return () => { cancelled = true }
    },
  }
  const feature = createFeature({ compat, config: { enabled: true, engine: { sweepIntervalMs: 0 } }, log: row => logs.push(row) })
  feature.start()
  for (let i = 0; !onWebServer && i < 20; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(typeof onWebServer, 'function', '应等待适配层获取 webServer')
  assert.equal(feature.state().mounted, false, '服务未就绪前不得报告挂载')

  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => { const index = routes.indexOf(route); if (index >= 0) routes.splice(index, 1) }
    },
  }
  onWebServer(webServer)

  assert.equal(feature.state().ok, true)
  assert.equal(feature.state().mounted, true)
  assert.ok(routes.some(route => route.path === '/watchkeeper/watch'))
  assert.ok(logs.some(row => row.type === 'watch-engine-mounted'))

  feature.dispose()
  for (const cleanup of cleanups.reverse()) cleanup()
  assert.equal(cancelled, true, '卸载时取消尚未完成的服务等待')
  assert.equal(routes.length, 0, '卸载时撤销引擎路由')
})

test('STOPPED cannot be bypassed by force on the prompt route', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { __test } = await import('../lib/watch/host.js')
  const web = { routes: [], register(route) { this.routes.push(route); return () => {} } }
  const ctx = { inject() {}, on() { return () => {} }, effect(fn) { fn(); return () => {} } }
  const { apply } = await import('../lib/watch/host.js')
  const controlDir = process.env.WATCHKEEPER_UI_CONTROL_DIR
  mkdirSync(controlDir, { recursive: true })
  writeFileSync(path.join(controlDir, 'state.json'), JSON.stringify({ state: 'STOPPED' }))
  let calls = 0
  process.env.WATCHKEEPER_CONTROL_TOKEN = 'fixture-control-token'
  __test.setHooks({ prompt: async () => { calls += 1 } })
  const dispose = apply(ctx, { sweepIntervalMs: 0 }, { webServer: web })
  const route = web.routes.find(row => row.path === '/watchkeeper/watch')
  const req = { method: 'POST', url: '/watchkeeper/watch/prompt', headers: { host: '127.0.0.1:3080', 'x-watchkeeper-control-token': 'fixture-control-token' }, on(name, fn) { this[name] = fn; return this } }
  const res = { statusCode: 0, setHeader() {}, end(value) { this.body = JSON.parse(value) } }
  try {
    const pending = route.handler(req, res)
    req.data(JSON.stringify({ sessionId: 'test-session', text: 'test', force: true }))
    req.end()
    await pending
    assert.equal(res.statusCode, 409)
    assert.equal(calls, 0)
  } finally { dispose?.(); __test.reset(); delete process.env.WATCHKEEPER_CONTROL_TOKEN }
})

test('write routes reject requests without a configured control token', async () => {
  const { apply } = await import('../lib/watch/host.js')
  const web = { routes: [], register(route) { this.routes.push(route); return () => {} } }
  const dispose = apply({ inject() {}, on() { return () => {} }, effect(fn) { fn(); return () => {} } }, { sweepIntervalMs: 0 }, { webServer: web })
  const route = web.routes.find(row => row.path === '/watchkeeper/watch')
  const req = { method: 'POST', url: '/watchkeeper/watch/sweep', headers: { host: '127.0.0.1:3080' }, on(name, fn) { if (name === 'end') queueMicrotask(fn); return this } }
  const res = { statusCode: 0, setHeader() {}, end(value) { this.body = JSON.parse(value) } }
  try { await route.handler(req, res); assert.equal(res.statusCode, 403) } finally { dispose?.() }
})
