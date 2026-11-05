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
