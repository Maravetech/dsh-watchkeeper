// Security regressions use a temporary state directory and a fake DSH host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const runtime = mkdtempSync(path.join(tmpdir(), 'watchkeeper-security-'))
process.env.WATCHKEEPER_HOME = path.join(runtime, 'home')
process.env.WATCHKEEPER_STATE_DIR = path.join(runtime, 'state')
process.env.WATCHKEEPER_UI_CONTROL_DIR = path.join(runtime, 'control')
process.on('exit', () => rmSync(runtime, { recursive: true, force: true }))

const host = await import('../lib/watch/host.js')
const { FILES } = await import('../lib/watch/paths.js')
const { controlFile } = await import('../lib/watch/control.js')
const events = new Map()
const routes = []
const ctx = {
  on(name, fn) { events.set(name, fn); return () => events.delete(name) },
  get() { return undefined },
  effect() { return () => {} },
}
host.apply(ctx, { sweepIntervalMs: 0, taskTool: { enabled: false } }, {
  webServer: { register(route) { routes.push(route); return () => {} } },
})
const route = routes.find(row => row.path === '/watchkeeper/watch').handler

function putJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

async function post(url, payload) {
  const req = Readable.from([JSON.stringify(payload)])
  req.method = 'POST'
  req.url = url
  req.headers = { host: '127.0.0.1:3080', origin: 'dsh://host' }
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(text) { this.body = text ? JSON.parse(text) : null },
  }
  await route(req, res)
  return res
}

test('STOPPED rejects prompt with or without force, before calling the delivery hook', async () => {
  putJson(controlFile(), { state: 'STOPPED' })
  let calls = 0
  host.__test.setHooks({ prompt: async () => { calls += 1 } })
  try {
    for (const force of [undefined, true]) {
      const response = await post('/watchkeeper/watch/prompt', { sessionId: 's-1', text: 'test', ...(force === undefined ? {} : { force }) })
      assert.equal(response.statusCode, 409)
      assert.equal(response.body.ok, false)
    }
    await assert.rejects(host.promptSession(ctx, 's-1', 'test'), { code: 'global-gate-blocked' })
    assert.equal(calls, 0)
  } finally {
    host.__test.reset()
    putJson(controlFile(), { state: 'IDLE' })
  }
})

test('a stop raised during async session activation blocks the final delivery', async () => {
  putJson(controlFile(), { state: 'IDLE' })
  let calls = 0
  const activatingCtx = {
    get(name) {
      if (name !== 'sessionController') return undefined
      return {
        async resolveAgent() { putJson(controlFile(), { state: 'STOPPED' }); return {} },
        async prompt() { calls += 1; return { accepted: true } },
      }
    },
  }
  try {
    await assert.rejects(host.promptSession(activatingCtx, 's-1', 'test'), { code: 'global-gate-blocked' })
    assert.equal(calls, 0)
  } finally {
    putJson(controlFile(), { state: 'IDLE' })
  }
})

test('fallback never accepts red lines or an unavailable judge; ordinary free-text/multi-select remain eligible', () => {
  assert.equal(host.canFallbackReply('red-line:不可逆或对外发布', '删除线上文件'), false)
  assert.equal(host.canFallbackReply('judge-human', '发布商品'), false)
  assert.equal(host.canFallbackReply('judge-unavailable', '核对本机文件'), false)
  assert.equal(host.canFallbackReply('judge-irreversible', '核对本机文件'), false)
  assert.equal(host.canFallbackReply('free-text', '核对本机文件'), true)
  assert.equal(host.canFallbackReply('multi-select', '核对本机文件'), true)
})

test('task grants bind task, session, operator and expiry; revocation stops active execution', async () => {
  const sessionId = 'feishu-exec-1'
  const taskId = 'task-1'
  assert.equal(host.findTaskGrant(sessionId, taskId), null)
  assert.throws(() => host.enableTakeover(sessionId, { authorizedBy: 'task', taskId }), { code: 'task-grant-missing' })
  const unregistered = await post('/watchkeeper/watch/toggle', { sessionId, enabled: true, authorizedBy: 'task', taskId })
  assert.equal(unregistered.statusCode, 403)
  assert.equal(unregistered.body.code, 'task-grant-missing')

  putJson(FILES.taskGrants, { grants: [{ taskId, sessionId, grantedBy: 'fenn', expiresAt: new Date(Date.now() - 1000).toISOString() }] })
  assert.equal(host.findTaskGrant(sessionId, taskId), null)
  assert.throws(() => host.enableTakeover(sessionId, { authorizedBy: 'task', taskId }), { code: 'task-grant-missing' })

  const expiresAt = new Date(Date.now() + 60_000).toISOString()
  putJson(FILES.taskGrants, { grants: [{ taskId, sessionId: 'feishu-other', grantedBy: 'fenn', expiresAt }] })
  assert.equal(host.findTaskGrant(sessionId, taskId), null)
  assert.throws(() => host.enableTakeover(sessionId, { authorizedBy: 'task', taskId }), { code: 'task-grant-missing' })

  putJson(FILES.taskGrants, { grants: [{ taskId, sessionId, grantedBy: 'fenn', expiresAt }] })
  assert.equal(host.findTaskGrant(sessionId, taskId).grantedBy, 'fenn')
  const lease = host.enableTakeover(sessionId, { authorizedBy: 'task', taskId, ttlMs: 10 * 60_000 })
  assert.equal(lease.grantedBy, 'fenn')
  assert.ok(Date.parse(lease.expiresAt) <= Date.parse(expiresAt))
  assert.equal(host.watchLeaseVerdict(sessionId, lease).allowed, true)
  assert.equal(host.stateSnapshot().sessions[sessionId], true)

  putJson(FILES.taskGrants, { grants: [] })
  assert.equal(host.watchLeaseVerdict(sessionId, lease).reason, 'task-grant-missing')
  assert.equal(host.stateSnapshot().sessions[sessionId], false)
  assert.equal(host.stateSnapshot().control[sessionId].reason, 'task-grant-missing')
  assert.equal(host.activeSessions().some(row => row.sessionId === sessionId), false)
  const result = await host.autoDriveSession(ctx, sessionId)
  assert.equal(result.reason, 'task-grant-missing')
  let passedToHuman = 0
  await events.get('user-questions/request')({ agent: { id: sessionId }, questions: [] }, () => { passedToHuman += 1 })
  assert.equal(passedToHuman, 1)
})
