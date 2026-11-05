import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('docs state the fail-closed control and fallback contract', () => {
  for (const file of ['README.md', 'README.zh-CN.md']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(text, /WATCHKEEPER_CONTROL_TOKEN/)
    assert.match(text, /fallbackEnabled/)
  }
  const config = readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8')
  assert.match(config, /\/bin\/sh -lc/)
  assert.match(config, /WATCHKEEPER_CONTROL_TOKEN/)
})
