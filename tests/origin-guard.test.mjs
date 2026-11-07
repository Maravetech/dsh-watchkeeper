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

test('measured DSH desktop cross-site request works only against a loopback Host', () => {
  const desktop = { origin: 'dsh-app://app', 'sec-fetch-site': 'cross-site' }
  assert.equal(originAllowed({ headers: { ...desktop, host: '127.0.0.1:3080' } }), true)
  assert.equal(originAllowed({ headers: { ...desktop, host: 'evil.example:3080' } }), false)
  for (const origin of ['dsh://host', 'dsh://evil', 'dsh-app://other', 'https://evil.example',
                        'http://127.0.0.1:3080']) {
    assert.equal(originAllowed({ headers: { origin, host: '127.0.0.1:3080',
                                            'sec-fetch-site': 'cross-site' } }), false, origin)
  }
  process.env.WATCHKEEPER_ALLOWED_ORIGINS = 'http://127.0.0.1:5173'
  try {
    assert.equal(originAllowed({ headers: { origin: 'http://127.0.0.1:5173', host: '127.0.0.1:3080',
                                          'sec-fetch-site': 'cross-site' } }), false)
  } finally { delete process.env.WATCHKEEPER_ALLOWED_ORIGINS }
})

test('null and browser cross-site requests without Origin are rejected', () => {
  assert.equal(originAllowed({ headers: { origin: 'null', host: '127.0.0.1:3080' } }), false)
  assert.equal(originAllowed({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
})
