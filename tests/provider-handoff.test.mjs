// Reply-provider orchestration with local fake commands. No real model, no
// network, no DSH session: temp runtime is removed on exit.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const runtime = mkdtempSync(path.join(tmpdir(), 'watchkeeper-provider-handoff-'))
process.env.WATCHKEEPER_HOME = path.join(runtime, 'home')
process.env.WATCHKEEPER_STATE_DIR = path.join(runtime, 'state')
process.env.WATCHKEEPER_UI_CONTROL_DIR = path.join(runtime, 'ui-control')
process.on('exit', () => rmSync(runtime, { recursive: true, force: true }))

const codexBin = path.join(runtime, 'codex')
const agyBin = path.join(runtime, 'agy')
writeFileSync(codexBin, '#!/bin/sh\nprintf "%s\\n" "codex-test-reply"\n')
writeFileSync(agyBin, '#!/bin/sh\nprintf "%s\\n" "agy-test-reply"\n')
chmodSync(codexBin, 0o755)
chmodSync(agyBin, 0o755)
process.env.WATCHKEEPER_CODEX_BIN = codexBin
process.env.WATCHKEEPER_AGY_BIN = agyBin
process.env.WATCHKEEPER_CUSTOM_CMD = "printf 'custom-test-reply\\n'"

const { canFallbackReply, enableTakeover, generateProviderReply, formatAutoReply, isTaskAuthorized, stateSnapshot } = await import('../lib/watch/host.js')

test('a caller-supplied task ID cannot authorize an excluded channel session', () => {
  assert.equal(isTaskAuthorized({ authorizedBy: 'task', taskId: 'arbitrary' }), false)
  assert.throws(() => enableTakeover('feishu-probe', { authorizedBy: 'task', taskId: 'arbitrary' }), /排除|excluded|通道/)
  assert.equal(stateSnapshot().sessions['feishu-probe'], undefined)
})

test('fallback never answers red lines or an unavailable judge', () => {
  for (const [reason, context] of [
    ['red-line:不可逆或对外发布', '删除线上文件'],
    ['judge-unavailable', '普通问题'],
    ['free-text', '普通问题'],
    ['multi-select', '普通问题'],
    ['judge-unsure', '发布商品'],
  ]) assert.equal(canFallbackReply(reason, context), false, reason)
  assert.equal(canFallbackReply('judge-unsure', '可逆的普通问题'), true)
})

test('single provider and a three-provider group both merge visible replies', async () => {
  const input = {
    parsed: { question: 'fixture question', context: 'fixture context', options: [] },
    picked: 'fixture decision',
    detail: {},
  }

  const solo = await generateProviderReply({ ...input, provider: ['codex'] })
  assert.match(solo.text, /\[codex\][\s\S]*codex-test-reply/)
  assert.equal(solo.partial, false)

  const group = await generateProviderReply({ ...input, provider: ['codex', 'agy', 'custom'] })
  assert.match(group.text, /\[codex\][\s\S]*codex-test-reply/)
  assert.match(group.text, /\[agy\][\s\S]*agy-test-reply/)
  assert.match(group.text, /\[custom\][\s\S]*custom-test-reply/)
  assert.equal(group.partial, false)

  const delivered = formatAutoReply(input.picked, ['codex', 'agy', 'custom'], group.text)
  assert.match(delivered, /^\[watchkeeper · codex \/ agy \/ custom group\] fixture decision/)
  assert.match(delivered, /codex-test-reply/)
  assert.match(delivered, /agy-test-reply/)
  assert.match(delivered, /custom-test-reply/)

  // A failing provider must not hide the successful ones.
  writeFileSync(agyBin, '#!/bin/sh\nprintf "%s\\n" "agy fixture failure" >&2\nexit 11\n')
  const partial = await generateProviderReply({ ...input, provider: ['codex', 'agy', 'custom'] })
  assert.equal(partial.partial, true)
  assert.match(partial.text, /codex-test-reply/)
  assert.doesNotMatch(partial.text, /agy-test-reply/)
  assert.match(partial.replyError, /agy/)
})
