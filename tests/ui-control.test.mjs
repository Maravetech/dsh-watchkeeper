import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const runtime = mkdtempSync(path.join(tmpdir(), 'watchkeeper-ui-control-'))
process.env.WATCHKEEPER_HOME = runtime
process.env.WATCHKEEPER_STATE_DIR = path.join(runtime, 'state')
process.env.WATCHKEEPER_UI_CONTROL_DIR = path.join(runtime, 'ui-control')
delete process.env.WATCHKEEPER_CONTROL_TOKEN
process.on('exit', () => rmSync(runtime, { recursive: true, force: true }))

const { apply } = await import('../lib/watch/host.js')

function request(route, url, body, extraHeaders = {}) {
  const listeners = new Map()
  const req = {
    method: 'POST', url,
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      cookie: 'browser-fixture',
      ...extraHeaders,
    },
    on(name, fn) { listeners.set(name, fn); return this },
  }
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(value) { this.body = value ? JSON.parse(value) : null },
  }
  return (async () => {
    const pending = route.handler(req, res)
    listeners.get('data')?.(JSON.stringify(body || {}))
    listeners.get('end')?.()
    await pending
    return res
  })()
}

test('UI switch is browser-authenticated, opt-in to enable, and always permits safe closure', async () => {
  const browserPeer = {}
  const connection = {
    browserPeer,
    admit(req) { return req.headers.cookie === 'browser-fixture' ? { peer: browserPeer } : { rejection: 401 } },
  }
  const web = { routes: [], register(route) { this.routes.push(route); return () => {} } }
  const ctx = {
    get(name) { return name === 'connection' ? connection : undefined },
    on() { return () => {} },
    effect(fn) { fn(); return () => {} },
  }
  const dispose = apply(ctx, { sweepIntervalMs: 0 }, { webServer: web })
  const route = web.routes.find(row => row.path === '/watchkeeper/watch')
  const url = '/watchkeeper/watch/toggle'
  const sessionId = 'session-ui-fixture'
  try {
    let res = await request(route, url, { sessionId, enabled: true })
    assert.equal(res.statusCode, 409)
    assert.equal(res.body.code, 'ui-enable-not-authorized')

    res = await request(route, url, { sessionId, enabled: false })
    assert.equal(res.statusCode, 200, 'closing needs neither opt-in nor control token')

    writeFileSync(path.join(runtime, 'operator.json'), JSON.stringify({ allowUiEnable: true }), { mode: 0o600 })
    if (process.platform !== 'win32') {
      chmodSync(path.join(runtime, 'operator.json'), 0o644)
      res = await request(route, url, { sessionId, enabled: true })
      assert.equal(res.statusCode, 409, 'a publicly readable opt-in file grants nothing')
      chmodSync(path.join(runtime, 'operator.json'), 0o600)
    }
    res = await request(route, url, { sessionId, enabled: true })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.state.sessions[sessionId], true)

    res = await request(route, '/watchkeeper/watch/stop', {})
    assert.equal(res.statusCode, 200)
    assert.equal(JSON.parse(readFileSync(path.join(runtime, 'ui-control', 'state.json'))).state, 'STOPPED')
    assert.equal(res.body.state.sessions[sessionId], false)

    res = await request(route, url, { sessionId, enabled: true })
    assert.equal(res.statusCode, 409, 'STOPPED blocks a new enable even with opt-in')
    res = await request(route, url, { sessionId, enabled: false })
    assert.equal(res.statusCode, 200, 'closing remains possible after STOPPED')

    res = await request(route, url, { sessionId, enabled: false }, { cookie: undefined })
    assert.equal(res.statusCode, 403, 'same-origin headers without a browser session need the token')
    res = await request(route, url, { sessionId, enabled: false }, { cookie: 'api-fixture' })
    assert.equal(res.statusCode, 403, 'an API Peer cannot claim the browser UI path')
    res = await request(route, '/watchkeeper/watch/prompt', { sessionId, text: 'probe' })
    assert.equal(res.statusCode, 403, 'other writes remain token-gated')

    for (const headers of [
      { host: '127.0.0.1.evil.test:3080', origin: 'http://127.0.0.1.evil.test:3080' },
      { origin: 'http://127.0.0.1:3080.evil.test' },
      { origin: 'null' },
      { origin: undefined, 'sec-fetch-site': 'cross-site' },
    ]) {
      res = await request(route, url, { sessionId, enabled: false }, headers)
      assert.equal(res.statusCode, 403)
    }

    process.env.WATCHKEEPER_CONTROL_TOKEN = 'fixture-only-control-token'
    res = await request(route, url, { sessionId, enabled: false }, {
      cookie: undefined, origin: undefined, 'sec-fetch-site': undefined,
      'x-watchkeeper-control-token': 'fixture-only-control-token',
    })
    assert.equal(res.statusCode, 200, 'a script retains the separate control-token path')
    res = await request(route, '/watchkeeper/watch/prompt', { sessionId, text: 'probe' }, {
      cookie: undefined, origin: undefined, 'sec-fetch-site': undefined,
      'x-watchkeeper-control-token': 'fixture-only-control-token',
    })
    assert.equal(res.statusCode, 409, 'STOPPED blocks prompt even on the token path')

    const controlFile = path.join(runtime, 'ui-control', 'state.json')
    writeFileSync(controlFile, '{corrupt')
    res = await request(route, '/watchkeeper/watch/stop', {}, {
      cookie: undefined, origin: undefined, 'sec-fetch-site': undefined,
      'x-watchkeeper-control-token': 'fixture-only-control-token',
    })
    assert.notEqual(res.statusCode, 200, 'a corrupt global control file must not be replaced')
    assert.equal(readFileSync(controlFile, 'utf8'), '{corrupt')
  } finally {
    dispose?.()
    delete process.env.WATCHKEEPER_CONTROL_TOKEN
  }
})
