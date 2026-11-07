import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('npm package includes every runtime non-JavaScript resource', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  const [packageInfo] = JSON.parse(output)
  const packed = new Set(packageInfo.files.map(file => file.path))
  const required = [
    'package.json',
    'README.md',
    'README.zh-CN.md',
    'cordis.patch.yml',
    'human-question.schema.json',
    'config/judgments.json',
    'icon.svg',
    'locale/en.json',
    'locale/zh.json',
    'skills/dsh-watchkeeper/SKILL.md',
  ]
  for (const path of required) {
    assert.ok(packed.has(path), `${path} is missing from npm pack`)
  }
})
