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

test('DNS rebinding cannot turn an attacker Host and matching Origin into a trusted UI', () => {
  for (const origin of ['http://evil.example:3080', 'https://evil.example:3080']) {
    assert.equal(originAllowed({ headers: { host: 'evil.example:3080', origin } }), false)
  }
  assert.equal(originAllowed({ headers: { host: 'evil.example:3080' } }), false)
  assert.equal(originAllowed({ headers: { host: 'evil.example@127.0.0.1:3080', origin: 'dsh://host' } }), false)
})

test('null and cross-site requests without Origin are rejected even when a localhost Host is present', () => {
  assert.equal(originAllowed({ headers: { host: '127.0.0.1:3080', origin: 'null' } }), false)
  assert.equal(originAllowed({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(originAllowed({ headers: { origin: 'dsh://host' } }), false)
  process.env.WATCHKEEPER_ALLOWED_ORIGINS = 'null'
  try { assert.equal(originAllowed({ headers: { host: '127.0.0.1:3080', origin: 'null' } }), false) }
  finally { delete process.env.WATCHKEEPER_ALLOWED_ORIGINS }
})

test('DSH desktop schemes and explicit local development origins remain usable', () => {
  for (const origin of ['dsh://host', 'dsh-app://app', 'http://127.0.0.1:3080']) {
    assert.equal(originAllowed({ headers: { host: '127.0.0.1:3080', origin } }), true)
  }
  assert.equal(originAllowed({ headers: { host: '127.0.0.1:3080', origin: 'dsh://evil' } }), false)
  process.env.WATCHKEEPER_ALLOWED_HOSTS = 'dev.local:3080'
  process.env.WATCHKEEPER_ALLOWED_ORIGINS = 'http://dev.local:3080'
  try { assert.equal(originAllowed({ headers: { host: 'dev.local:3080', origin: 'http://dev.local:3080' } }), true) }
  finally { delete process.env.WATCHKEEPER_ALLOWED_HOSTS; delete process.env.WATCHKEEPER_ALLOWED_ORIGINS }
})
