import test from 'node:test'
import assert from 'node:assert/strict'
import { originAllowed, rejectForeignOrigin } from '../lib/origin-guard.js'

function res() {
  const headers = {}
  return { headers, statusCode: 0, body: null, setHeader: (k, v) => { headers[k] = v }, end(b) { this.body = b ? JSON.parse(b) : null } }
}

test('no Origin header (curl, server-side) is allowed', () => {
  assert.equal(originAllowed({ headers: { host: '127.0.0.1:3080' } }), true)
})

test('the DSH web UI origin (same host) is allowed and gets CORS headers', () => {
  const r = res()
  const req = { headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }
  assert.equal(rejectForeignOrigin(req, r), false)
  assert.equal(r.headers['access-control-allow-origin'], 'http://127.0.0.1:3080')
})

test('a foreign web page is rejected with 403 and no CORS headers', () => {
  const r = res()
  const req = { headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } }
  assert.equal(rejectForeignOrigin(req, r), true)
  assert.equal(r.statusCode, 403)
  assert.equal(r.headers['access-control-allow-origin'], undefined)
})

test('another localhost port is rejected unless listed in WATCHKEEPER_ALLOWED_ORIGINS', () => {
  const req = { headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:3080' } }
  assert.equal(originAllowed(req), false)
  process.env.WATCHKEEPER_ALLOWED_ORIGINS = 'http://127.0.0.1:5173'
  try { assert.equal(originAllowed(req), true) } finally { delete process.env.WATCHKEEPER_ALLOWED_ORIGINS }
})

test('a malformed Origin is rejected', () => {
  assert.equal(originAllowed({ headers: { origin: 'null', host: '127.0.0.1:3080' } }), false)
})

test('an attacker-controlled Host cannot become a trusted origin', () => {
  assert.equal(originAllowed({ headers: { origin: 'http://evil.example:3080', host: 'evil.example:3080' } }), false)
  assert.equal(originAllowed({ headers: { host: 'evil.example:3080' } }), false)
  assert.equal(originAllowed({ headers: { origin: 'https://127.0.0.1:3080', host: '127.0.0.1:3080' } }), false)
})

test('known DSH desktop origins work only against a loopback Host', () => {
  for (const origin of ['dsh://host', 'dsh-app://app']) {
    assert.equal(originAllowed({ headers: { origin, host: '127.0.0.1:3080' } }), true)
    assert.equal(originAllowed({ headers: { origin, host: 'evil.example:3080' } }), false)
  }
  assert.equal(originAllowed({ headers: { origin: 'dsh://evil', host: '127.0.0.1:3080' } }), false)
})

test('null and browser cross-site requests without Origin are rejected', () => {
  assert.equal(originAllowed({ headers: { origin: 'null', host: '127.0.0.1:3080' } }), false)
  assert.equal(originAllowed({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
})
