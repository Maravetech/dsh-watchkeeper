import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('CI has read-only token and immutable official action references', () => {
  const yml = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8')
  assert.match(yml, /permissions:\s*\n\s*contents: read/)
  assert.doesNotMatch(yml, /actions\/(?:checkout|setup-node)@v\d/)
})
