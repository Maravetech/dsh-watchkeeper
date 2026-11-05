import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createFeature } from '../lib/features/numbers.js'

test('two feature instances preserve each other\'s assigned session numbers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'watchkeeper-numbers-'))
  const listeners = []
  const ledger = path.join(dir, 'numbers.json')
  const compat = { core: dir, on(_name, fn) { listeners.push(fn) } }
  try {
    createFeature({ compat, config: { enabled: true, ledger }, log() {} }).start()
    createFeature({ compat, config: { enabled: true, ledger }, log() {} }).start()
    listeners[0]({ id: 'session-a' }, { type: 'session/title', data: { title: 'A' } })
    listeners[1]({ id: 'session-b' }, { type: 'session/title', data: { title: 'B' } })
    const rows = JSON.parse(readFileSync(ledger, 'utf8')).numbers
    assert.equal(rows['session-a'].n, 1)
    assert.equal(rows['session-b'].n, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
