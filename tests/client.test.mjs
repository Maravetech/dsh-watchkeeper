// 值守台客户端半单测：直接驱动包根 client.js 的 bundle。
//
// 覆盖：唯一 bundle 与 id、无顶层 ESM、五项铁律（互斥锁 / 幂等 / 防抖 / 自身豁免 / 作用域）、
//       定时器清理出口、apply 的旁路与解注册、以及「不加载 Client 包 / 不碰 document.body」两条规范。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(path.join(HERE, '..', 'client.js'), 'utf8')

/** 去掉注释后的代码文本：规范检查只看代码，不看注释里的说明。 */
function strippedCode() {
  return SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function fakeDom() {
  const rows = []
  const makeRow = sessionId => {
    const children = []
    const node = {
      attrs: { 'data-row-key': `session:${sessionId}` },
      getAttribute: name => node.attrs[name] ?? null,
      isConnected: true,
      firstChild: null,
      children,
      querySelector: selector => children.find(child => selector.includes(child.className)) || null,
      insertBefore: (child, before) => { children.unshift(child); node.firstChild = before === null ? null : before; child.isConnected = true; return child },
    }
    rows.push(node)
    return node
  }
  const tree = { }
  return {
    rows, makeRow,
    document: {
      head: { appendChild() {} },
      getElementById: () => null,
      querySelector: selector => (selector === '[role="tree"]' ? tree : null),
      querySelectorAll: selector => (selector.includes('session:') ? rows : []),
      addEventListener() {}, removeEventListener() {},
    },
    observed: [],
    MutationObserver: class { constructor(cb) { this.cb = cb } observe(target, options) { this.target = target; this.options = options } disconnect() { this.disconnected = true } },
  }
}

function loadBundle(dom = fakeDom(), options = {}) {
  let definition = null
  const window = {
    __ModuleLoader__: { load: def => { definition = def } },
    addEventListener() {}, removeEventListener() {},
  }
  const location = options.location || { protocol: 'http:', origin: 'http://127.0.0.1:52562' }
  const fetch = options.fetch || (async () => ({ ok: true, json: async () => ({ ok: true, rows: [{ sessionId: 'a', n: '1' }] }) }))
  const document = dom.document
  const MutationObserver = dom.MutationObserver
  globalThis.MutationObserver = MutationObserver
  const runner = new Function('window', 'document', 'location', 'fetch', 'MutationObserver', 'globalThis', SOURCE)
  runner(window, document, location, fetch, MutationObserver, globalThis)
  return definition
}

const require = id => {
  if (id === 'react') return { createElement: () => null, useState: v => [v, () => {}], useEffect() {}, useRef: v => ({ current: v }) }
  throw Error(`未提供的模块：${id}`)
}

test('bundle：id 正确、无顶层 ESM、只注册一个工厂', () => {
  const def = loadBundle()
  assert.equal(def.id, 'dsh-watchkeeper')
  assert.equal(typeof def.factory, 'function')
  assert.equal(SOURCE.match(/__ModuleLoader__\.load\(/g).length, 1)
  assert.equal(/^\s*(import|export)\s/m.test(SOURCE), false)
})

test('五项铁律：互斥锁 / 防抖调度 / 自身变动豁免 / 作用域收敛 / 定时器清理出口都在', () => {
  const code = strippedCode()
  assert.ok(code.includes('isMutatingDom'), '缺变动互斥锁')
  assert.ok(code.includes('scheduleRender'), '缺防抖调度')
  assert.ok(code.includes('ownsNodes') || code.includes('ownNodes'), '缺自身变动豁免')
  assert.ok(code.includes('[role="tree"]') && code.includes('data-row-key'), '缺作用域收敛（只观察会话树、只改会话行）')
  assert.ok(code.includes('MutationObserver'))
  assert.ok(code.includes('setInterval(') && code.includes('clearInterval('), '有轮询就必须有清理')
  assert.ok(code.includes('remove()'), '缺「没有号就摘掉自己那一列」的幂等路径')
})

test('规范：不加载 Harness Client 包、不往 document.body 追加节点', () => {
  const code = strippedCode()
  assert.equal(code.includes('dsh-client-ui-primitives'), false)
  assert.equal(/createPortal\s*\(/.test(code), false)
  assert.equal(/document\.body/.test(code), false)
})

test('apply：注册即取证；enabled=false 或没有 effect 时也不抛，disposer 能停表', () => {
  const def = loadBundle()
  const exports = def.factory(require)
  const effects = []
  const ctx = {
    styles: { insert() {} },
    effect(fn) { effects.push(fn()); return () => { for (const off of effects) { try { off() } catch { /* ignore */ } } } },
    on() { return () => {} },
  }
  const off = exports.apply(ctx, {})
  assert.equal(typeof off, 'function')
  assert.ok(exports.__internals.state.timer !== null, '挂了 ctx.effect 也必须真的开始跑（计时器要在）')
  off()
  assert.equal(exports.__internals.state.timer, null, '停表后不应留定时器')

  const offDisabled = exports.apply(ctx, { enabled: false })
  assert.equal(typeof offDisabled, 'function')
  offDisabled()
})

test('待答卡在消息下方、值守开关在输入框上方的官方插槽', () => {
  const def = loadBundle()
  const exports = def.factory(require)
  const registered = []
  const slots = {
    inject(name, cb) { const off = cb(); return () => { try { off?.() } catch { /* ignore */ } } },
    register(options) { registered.push(options); return () => {} },
  }
  const off = exports.apply({ styles: { insert() {} }, effect(fn) { fn(); return () => {} }, get: name => (name === 'slots' ? slots : undefined) }, {})
  const names = registered.map(r => r.name)
  assert.ok(names.includes('conversation.chat.turnTail'), '缺消息下方的问题卡座位')
  // fenn 2026-11-05 裁定：开源插件重新提供当前会话的值守开关。
  assert.ok(registered.some(row => row.name === 'conversation.input.dock' && row.id === 'watchkeeper-watch-switch'))
  assert.equal(strippedCode().includes('function ToolRow'), false, '工具行代码已删除')
  assert.equal(strippedCode().includes('ProviderSwitches'), false, 'Provider 开关代码已删除')
  const code = strippedCode()
  assert.equal(/createPortal\s*\(/.test(code), false)
  assert.equal(/document\.body/.test(code), false)
  off()
})

test('已注册的座位能真实调用组件，不能只验证注册名', () => {
  const api = loadBundle().factory(require)
  const components = []
  const slots = {
    inject(_name, cb) { return cb() },
    register(options, component) { components.push({ options, component }); return () => {} },
  }
  const off = api.apply({ get: name => name === 'slots' ? slots : undefined }, {})
  try {
    const seat = components.find(row => row.options.id === 'watchkeeper-question-card')
    assert.ok(seat)
    assert.doesNotThrow(() => seat.component({ sessionId: 'test-render-only', seq: 'test-render-only' }))
    const watch = components.find(row => row.options.id === 'watchkeeper-watch-switch')
    assert.ok(watch)
    assert.doesNotThrow(() => watch.component({ sessionId: 'test-render-only' }))
  } finally { off() }
})

test('Web switch writes use the page origin and never place a control token in requests', async () => {
  const sent = []
  const api = loadBundle(fakeDom(), {
    fetch: async (url, init) => { sent.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true }) } },
  }).factory(require)
  await api.__internals.postUiControl('toggle', { sessionId: 'session-fixture', enabled: false })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'http://127.0.0.1:52562/watchkeeper/watch/toggle')
  assert.equal(sent[0].init.credentials, 'same-origin')
  assert.equal(sent[0].init.headers['x-watchkeeper-control-token'], undefined)
  assert.equal(sent[0].url.includes('token'), false)
})

test('口径：文案走包内默认表，且与 locale 文件同键', () => {
  const internals = loadBundle().factory(require).__internals
  const zh = JSON.parse(readFileSync(path.join(HERE, '..', 'locale', 'zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(path.join(HERE, '..', 'locale', 'en.json'), 'utf8'))
  for (const key of Object.keys(internals.TEXTS)) {
    assert.equal(typeof zh[key], 'string', `locale/zh.json 缺 ${key}`)
    assert.equal(typeof en[key], 'string', `locale/en.json 缺 ${key}`)
  }
  assert.equal(internals.translate(undefined, 'numbers.title'), 'Session numbers')
  assert.equal(internals.translate(key => (key === 'numbers.title' ? 'Session numbers' : ''), 'numbers.title'), 'Session numbers')
})

test('值守状态与编号共用同一个心跳（不新增定时器）', () => {
  const code = strippedCode()
  const intervals = (code.match(/setInterval\(/g) || []).length
  const clears = (code.match(/clearInterval\(/g) || []).length
  assert.equal(intervals, clears, '每个 setInterval 都要有对应的 clearInterval')
  assert.match(code, /subscribeDuty/, '值守状态必须走共享订阅')
  assert.match(code, /data-watch-duty/, '值守开着的会话行要有自己的标记（只打属性，不插节点）')
})

test('自动代答标记：只打属性 + CSS 前缀（不插节点、不改文案）', () => {
  const code = strippedCode()
  assert.match(code, /data-watch-auto/, '自动代答的气泡要有自己的标记')
  assert.match(code, /paintAutoReplies/, '标记要由共享心跳后的那次绘制统一处理')
  assert.equal(/createPortal\s*\(/.test(code), false)
  assert.equal(/document\.body\.(append|insert)/.test(code), false)
})
