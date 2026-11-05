import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'watchkeeper-lock-'))
process.env.WATCHKEEPER_STATE_DIR = root
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

const { acquireDecisionLock, touchDecisionLock, readDecisionLock } = await import('../lib/watch/outbox.js')

test('the holder can extend its decision lock without corrupting the path', () => {
  const first = acquireDecisionLock({ sessionId: 'session-a', fingerprint: 'fingerprint-a', instanceId: 'owner-a', now: 1000, ttlMs: 100 })
  assert.equal(first.ok, true)
  const renewed = touchDecisionLock('session-a', 'fingerprint-a', { instanceId: 'owner-a', now: 1050, ttlMs: 100 })
  assert.equal(renewed.expiresAt, new Date(1150).toISOString())
  assert.equal(readDecisionLock('session-a', 'fingerprint-a').expiresAt, renewed.expiresAt)
})

test('a renewed lock cannot be stolen at the original TTL', () => {
  const now = Date.now()
  assert.equal(acquireDecisionLock({ sessionId: 'session-b', fingerprint: 'fingerprint-b', instanceId: 'owner-a', now, ttlMs: 100 }).ok, true)
  touchDecisionLock('session-b', 'fingerprint-b', { instanceId: 'owner-a', now: now + 50, ttlMs: 100 })
  const peer = acquireDecisionLock({ sessionId: 'session-b', fingerprint: 'fingerprint-b', instanceId: 'owner-b', now: now + 101, ttlMs: 100 })
  assert.equal(peer.ok, false)
  assert.equal(peer.holder, 'owner-a')
})
