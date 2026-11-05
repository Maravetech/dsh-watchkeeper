import { applyCors } from '../origin-guard.js'
// 宿主侧版本适配层（共享库 integrations/dsh-compat）—— 把「DeepSeek Harness 这一版长什么样」与业务代码隔开。
//
// 这是**全项目唯一**的宿主侧适配实现：各插件包通过相对路径引它，不再各写一份。
//
// 三件事：
//   1. 取服务：优先官方写法 `ctx.inject([name], cb)`，退回 `ctx.get(name)`、`ctx[name]`，
//      三条路都没拿到就按 250ms 低频重试（unref，不吊住进程），并把实际走通的那条记进报告。
//   2. 生命周期与计时器：`ctx.effect` → `ctx.timer.interval` → 裸 setInterval（unref + 登记），
//      全部经本层，业务代码不再各写一遍。
//   3. 路由：一次登记 exact + prefix 两套，响应统一带 CORS；prefix 被旧实例占住时
//      exact 仍能服务（新版 webServer 明确「重复 (kind,path) 会抛」）。
//
// 版本升级时的唯一改动点：lib/compat/features.js（登记表）+ 本文件的探测/降级分支。

import { execFile, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEGRADE, HOST } from './features.js'

export const ADAPTER_REVISION = 'dsh-watchkeeper/host-compat@1'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Persistent home for plugin state (overridable, see lib/watch/paths.js).
 *  Default: ~/.dsh-watchkeeper */
export const CORE_ROOT = process.env.WATCHKEEPER_HOME
  || path.join(os.homedir(), '.dsh-watchkeeper')

/** 运行期探测到的能力（health 报告的主体）。 */
function emptyCaps() {
  return {
    adapter: ADAPTER_REVISION,
    coreRoot: CORE_ROOT,
    version: { value: null, via: null, tested: false },
    services: {},
    routes: { exact: 0, prefix: null },
    timers: { via: null },
    lifecycle: { via: null },
    events: { subscribed: [], missing: [] },
    degraded: [],
  }
}

/**
 * 探测 DSH 版本：只做尽力而为，取不到就如实写 null。
 * 依次试：环境变量 → Electron 主进程 argv 里的 app.asar → 解析安装包自身 package.json。
 */
export function detectVersion(env = process.env, argv = process.argv) {
  for (const key of ['DSH_VERSION', 'DSH_APP_VERSION']) {
    if (env[key]) return { value: String(env[key]), via: `env:${key}` }
  }
  const asar = (argv || []).find(a => typeof a === 'string' && a.includes('.asar'))
  if (asar) {
    const root = asar.slice(0, asar.indexOf('.asar') + '.asar'.length)
    for (const rel of ['dsh/package.json', 'package.json']) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(root, rel), 'utf8'))
        if (pkg?.version) return { value: String(pkg.version), via: `asar:${rel}` }
      } catch { /* 继续试下一个 */ }
    }
  }
  try {
    const req = createRequire(path.join(env.DSH_PROFILE_DIR || CORE_ROOT, 'package.json'))
    const pkgPath = req.resolve('@deepseek-ai/dsh/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg?.version) return { value: String(pkg.version), via: 'resolve:@deepseek-ai/dsh' }
  } catch { /* 取不到就算了 */ }
  return { value: null, via: null }
}

/** 追加式取证日志：目录不存在就建；坏目录、无权限都只吞掉，绝不影响主链路。 */
export function createLogger(file) {
  let warned = false
  let ready = false
  const ensure = () => {
    if (ready) return true
    mkdirSync(path.dirname(file), { recursive: true })
    ready = true
    return true
  }
  return function log(entry) {
    try {
      ensure()
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
    } catch (error) {
      if (!warned) { warned = true; try { console.warn('[status-dock] 日志写入失败：', error?.message ?? error) } catch { /* ignore */ } }
    }
  }
}

/** 解析一段 JSON 文本；失败返回 undefined（调用方决定降级文案）。 */
export function parseJson(text) {
  try {
    const value = JSON.parse(String(text ?? ''))
    return value && typeof value === 'object' ? value : undefined
  } catch { return undefined }
}

export function createHostCompat(ctx, { config = {}, log = () => {} } = {}) {
  const caps = emptyCaps()
  const disposers = new Set()
  const intervals = new Set()
  let disposed = false

  // ------------------------------------------------------------------ 生命周期
  const effect = typeof ctx?.effect === 'function'
    ? (fn) => { caps.lifecycle.via = 'ctx.effect'; const off = ctx.effect(fn); if (typeof off === 'function') disposers.add(off); return off }
    : (fn) => {
      caps.lifecycle.via = "ctx.on('dispose')"
      const off = fn()
      const wrapped = typeof off === 'function' ? off : () => {}
      disposers.add(wrapped)
      try { ctx?.on?.('dispose', wrapped) } catch { /* ignore */ }
      return wrapped
    }
  if (typeof ctx?.effect === 'function') caps.lifecycle.via = 'ctx.effect'

  // ------------------------------------------------------------------ 计时器
  const timerService = (() => {
    try {
      const svc = typeof ctx?.get === 'function' ? ctx.get('timer') : undefined
      return svc && typeof svc.interval === 'function' ? svc : (ctx?.timer && typeof ctx.timer.interval === 'function' ? ctx.timer : null)
    } catch { return null }
  })()

  function interval(fn, ms) {
    if (disposed) return () => {}
    if (timerService) {
      caps.timers.via = 'ctx.timer.interval'
      const off = timerService.interval(fn, ms)
      const stop = typeof off === 'function' ? off : () => {}
      intervals.add(stop)
      return () => { intervals.delete(stop); try { stop() } catch { /* ignore */ } }
    }
    caps.timers.via = 'setInterval(unref)'
    const handle = setInterval(fn, ms)
    if (typeof handle.unref === 'function') handle.unref()
    const stop = () => clearInterval(handle)
    intervals.add(stop)
    return () => { intervals.delete(stop); try { stop() } catch { /* ignore */ } }
  }

  function timeout(fn, ms) {
    if (disposed) return () => {}
    if (timerService && typeof timerService.timeout === 'function') {
      const off = timerService.timeout(fn, ms)
      const stop = typeof off === 'function' ? off : () => {}
      intervals.add(stop)
      return stop
    }
    const handle = setTimeout(fn, ms)
    if (typeof handle.unref === 'function') handle.unref()
    const stop = () => clearTimeout(handle)
    intervals.add(stop)
    return stop
  }

  // ------------------------------------------------------------------ 取服务
  /** 同步试一次（get / property 两条兼容路径）。 */
  function peekService(name) {
    try {
      const via = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
      if (via) return { svc: via, via: 'ctx.get' }
    } catch { /* ignore */ }
    try {
      const direct = ctx?.[name]
      if (direct) return { svc: direct, via: 'ctx[name]' }
    } catch { /* ignore */ }
    return null
  }

  /**
   * 等一个服务可用：先官方 `ctx.inject` 写法，再同步 peek，最后 250ms 低频重试。
   * `cb(service)` 只在拿到时调用一次；返回取消函数。
   */
  function whenService(name, cb) {
    const spec = HOST.services[name] || { optional: true, acquire: ['inject', 'get', 'property'] }
    let done = false
    let stop = () => {}

    const settle = (svc, via) => {
      if (done || disposed || !svc) return
      done = true
      caps.services[name] = { ok: true, via }
      try { cb(svc) } catch (error) {
        caps.services[name] = { ok: false, via, error: String(error?.message ?? error) }
        log({ type: 'service-callback-error', service: name, message: String(error?.message ?? error) })
      }
      stop()
    }

    const peek = peekService(name)
    if (peek) { settle(peek.svc, peek.via); return () => {} }

    if (spec.acquire.includes('inject') && typeof ctx?.inject === 'function') {
      try {
        const cancel = ctx.inject([name], scope => {
          let svc
          try { svc = typeof scope?.get === 'function' ? scope.get(name) : undefined } catch { svc = undefined }
          if (!svc) svc = scope?.[name]
          settle(svc, 'ctx.inject')
          return () => { /* 框架管回收 */ }
        })
        if (typeof cancel === 'function') disposers.add(cancel)
      } catch (error) {
        log({ type: 'inject-error', service: name, message: String(error?.message ?? error) })
      }
    }

    // Cordis may call an injection callback synchronously when the provider is
    // already available through its injection graph but not through ctx.get().
    // In that case settle() ran before `stop` was assigned; do not create a
    // fallback poll that can never discover anything new.
    if (done || disposed) return () => { done = true; stop() }

    const wait = interval(() => {
      const hit = peekService(name)
      if (hit) settle(hit.svc, `${hit.via}(retry)`)
    }, 250)
    stop = () => { try { wait() } catch { /* ignore */ } }

    if (!caps.services[name]) caps.services[name] = { ok: false, via: null, optional: Boolean(spec.optional) }
    return () => { done = true; stop() }
  }

  // ------------------------------------------------------------------ 路由
  function cors(req, res) {
    return applyCors(req, res)
  }


  function json(res, status, body) {
    try {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    } catch { /* 响应可能已发出 */ }
  }

  function readBody(req, limit = 64 * 1024) {
    return new Promise(resolve => {
      let data = ''
      let done = false
      const finish = () => { if (!done) { done = true; resolve(data) } }
      try {
        req.on('data', chunk => {
          data += chunk
          if (data.length > limit) { finish(); try { req.destroy() } catch { /* ignore */ } }
        })
        req.on('end', finish)
        req.on('error', finish)
      } catch { finish() }
    })
  }

  /**
   * 登记路由：先 exact（每条已知路径各一条），再 prefix（兜底 + 覆盖未知子路径）。
   * 重复登记会抛 —— prefix 被旧实例占住时只记事实，exact 仍然服务。
   */
  function mountRoute(web, basePath, paths, handler) {
    const disposersForRoutes = []
    for (const p of paths) {
      try {
        const off = web.register({ kind: 'exact', path: p, handler })
        if (typeof off === 'function') disposersForRoutes.push(off)
        caps.routes.exact += 1
      } catch (error) {
        log({ type: 'route-attach-error', kind: 'exact', path: p, message: String(error?.message ?? error) })
      }
    }
    try {
      const off = web.register({ kind: 'prefix', path: basePath, handler })
      if (typeof off === 'function') disposersForRoutes.push(off)
      caps.routes.prefix = 'ok'
    } catch (error) {
      caps.routes.prefix = 'collision'
      log({ type: 'route-attach-error', kind: 'prefix', path: basePath, message: String(error?.message ?? error) })
    }
    const dispose = () => { for (const off of disposersForRoutes) { try { off() } catch { /* ignore */ } } }
    disposers.add(dispose)
    return dispose
  }

  // ------------------------------------------------------------------ 事件
  /** emit 事件：只观察；waterfall 事件：包 next() 后原样委派。 */
  function on(name, fn) {
    const mode = HOST.events[name] || 'emit'
    if (typeof ctx?.on !== 'function') { caps.events.missing.push(name); return () => {} }
    try {
      const off = mode === 'waterfall'
        ? ctx.on(name, (...args) => {
          const next = args[args.length - 1]
          const payload = args.slice(0, -1)
          try { fn(...payload) } catch (error) { log({ type: 'event-error', name, message: String(error?.message ?? error) }) }
          return typeof next === 'function' ? next() : undefined
        })
        : ctx.on(name, (...args) => {
          try { fn(...args) } catch (error) { log({ type: 'event-error', name, message: String(error?.message ?? error) }) }
        })
      caps.events.subscribed.push(name)
      if (typeof off === 'function') disposers.add(off)
      return off
    } catch (error) {
      caps.events.missing.push(name)
      log({ type: 'event-subscribe-error', name, message: String(error?.message ?? error) })
      return () => {}
    }
  }

  /**
   * 包住一个 waterfall 事件的**真实执行时长**：
   *   · 普通 Promise 返回值 —— 等它 settle 再收尾；
   *   · AsyncIterable（如 `llm/stream`）—— 包一层生成器，迭代结束（含异常）才收尾。
   * 只观测，不改数据：返回值原样透传。
   */
  function around(name, { enter, exit } = {}) {
    if (typeof ctx?.on !== 'function') { caps.events.missing.push(name); return () => {} }
    const handler = (...args) => {
      const next = args[args.length - 1]
      if (typeof next !== 'function') return undefined
      let entered = false
      const safeEnter = () => { if (!entered) { entered = true; try { enter?.() } catch { /* ignore */ } } }
      const safeExit = () => { if (entered) { entered = false; try { exit?.() } catch { /* ignore */ } } }
      safeEnter()
      let result
      try { result = next() } catch (error) { safeExit(); throw error }
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(
          value => { safeExit(); return value },
          error => { safeExit(); throw error },
        )
      }
      if (result && typeof result[Symbol.asyncIterator] === 'function') {
        return (async function* wrapped() {
          try { yield* result } finally { safeExit() }
        })()
      }
      safeExit()
      return result
    }
    try {
      const off = ctx.on(name, handler)
      caps.events.subscribed.push(`${name}(around)`)
      if (typeof off === 'function') disposers.add(off)
      return off
    } catch (error) {
      caps.events.missing.push(name)
      log({ type: 'event-subscribe-error', name, message: String(error?.message ?? error) })
      return () => {}
    }
  }

  /** 跑一条命令只取文本输出（git status 这类），失败如实返回，不抛。 */
  function runText(cmd, args, { timeoutMs = 8_000 } = {}) {
    return new Promise(resolve => {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }, (error, stdout) => {
        resolve({ ok: !error, stdout: String(stdout || ''), error: error ? String(error.message ?? error) : null })
      })
    })
  }

  // ------------------------------------------------------------------ 子进程
  function runJson(python, args, { timeoutMs = 30_000, sync = false } = {}) {
    const spec = { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: process.env }
    if (sync) {
      try {
        const out = execFileSync(python, args, { ...spec, encoding: 'utf8' })
        const parsed = parseJson(out)
        return parsed ? { ok: true, value: parsed } : { ok: false, error: DEGRADE.scriptMissing.error }
      } catch (error) {
        const text = String(error?.stdout ?? '')
        const parsed = parseJson(text)
        if (parsed) return { ok: true, value: parsed, warning: String(error?.message ?? error) }
        const timeout = error?.killed || error?.signal ? DEGRADE.scriptTimeout.error : DEGRADE.scriptMissing.error
        return { ok: false, error: timeout, detail: String(error?.message ?? error) }
      }
    }
    return new Promise(resolve => {
      execFile(python, args, spec, (error, stdout) => {
        const parsed = parseJson(stdout)
        if (parsed) resolve({ ok: true, value: parsed, warning: error ? String(error?.message ?? error) : undefined })
        else if (error) resolve({ ok: false, error: error.killed || error.signal ? DEGRADE.scriptTimeout.error : DEGRADE.scriptMissing.error, detail: String(error?.message ?? error) })
        else resolve({ ok: false, error: DEGRADE.scriptMissing.error })
      })
    })
  }

  function health() {
    const version = caps.version
    return {
      ok: true,
      adapter: ADAPTER_REVISION,
      at: new Date().toISOString(),
      version: version.value,
      versionVia: version.via,
      testedAgainst: version.tested,
      services: caps.services,
      routes: caps.routes,
      timers: caps.timers,
      lifecycle: caps.lifecycle,
      events: caps.events,
      degraded: caps.degraded,
      pid: process.pid,
    }
  }

  function markDegraded(what, detail) {
    caps.degraded.push({ what, detail: detail == null ? null : String(detail) })
    log({ type: 'degraded', what, detail: detail == null ? null : String(detail) })
  }

  function dispose() {
    disposed = true
    for (const stop of intervals) { try { stop() } catch { /* ignore */ } }
    intervals.clear()
    for (const off of disposers) { try { off() } catch { /* ignore */ } }
    disposers.clear()
  }

  const detected = detectVersion()
  caps.version = { ...detected, tested: false }

  return {
    caps,
    ctx,
    config,
    log,
    core: CORE_ROOT,
    effect,
    interval,
    timeout,
    whenService,
    around,
    mountRoute,
    cors,
    json,
    readBody,
    on,
    runJson,
    runText,
    health,
    markDegraded,
    dispose,
    get disposed() { return disposed },
    setVersionTested(flag) { caps.version.tested = Boolean(flag) },
  }
}
