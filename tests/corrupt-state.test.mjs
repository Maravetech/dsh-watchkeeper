import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = mkdtempSync(path.join(tmpdir(), 'watchkeeper-corrupt-'))
process.env.WATCHKEEPER_STATE_DIR = root
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const { FILES } = await import('../lib/watch/paths.js')
const { withStore } = await import('../lib/watch/lease.js')
const { withOps } = await import('../lib/watch/outbox.js')

test('corrupt lease and outbox files are preserved and block writes', () => {
  mkdirSync(root, { recursive: true })
  for (const [file, update] of [[FILES.leases, withStore], [FILES.ops, withOps]]) {
    writeFileSync(file, '{broken json')
    assert.throws(() => update(() => {}), /corrupt|损坏/i)
    assert.equal(readFileSync(file, 'utf8'), '{broken json')
  }
})

test('valid JSON with missing required state shape also blocks writes', () => {
  for (const [file, update] of [[FILES.leases, withStore], [FILES.ops, withOps]]) {
    writeFileSync(file, '{}')
    assert.throws(() => update(() => {}), /corrupt|损坏/i)
    assert.equal(readFileSync(file, 'utf8'), '{}')
  }
})
