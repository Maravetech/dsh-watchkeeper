// 值守台 —— 宿主半：共享适配层 + 读数/能力注册表 + 一条路由族。
//
// 分组（the operator 2026-10-15 定的四刀）：
//   ① 会话编号（本文件已接）
//   ② 待答卡（问题登记 + 会话内问题卡 + 一处批量答 + 投递口）
//   ③ 值守引擎（判断、租约、转人工）—— 逐块搬，对外服务名不变
//   ④ 旧包下线
//
// 所有版本敏感的东西都在共享适配层 integrations/dsh-compat；本文件不出现
// `ctx.get('webServer')`、裸 setInterval、ctx.on('dispose') 这类写法。

import { rejectForeignOrigin } from './origin-guard.js'
import path from 'node:path'

export const name = 'watchkeeper'
export const inject = []
export const BASE_PATH = '/watchkeeper'

/** 与 status-dock 同一套「整图重载」：静态 import 的依赖会被进程级缓存钉住，必须带 query 重取。 */
async function loadGraph() {
  const query = new URL(import.meta.url).search
  const here = (rel) => new URL(`${rel}${query}`, import.meta.url).href
  // 共享适配层是**必需件**：它坏了整包确实没法工作，这里保持快速失败。
  const [compatHost, compatFeatures] = await Promise.all([
    import(here('./dsh-compat/host.js')),
    import(here('./dsh-compat/features.js')),
  ])
  // 特性模块**逐个隔离**：任何一个坏掉（语法错、相对路径写错、依赖缺失）只让那一块降级，
  // 绝不拖着整包一起从界面上消失 —— 实测踩过：引擎搬迁时相对路径写错，整个包不显示。
  const spec = [
    ['numbers', './features/numbers.js'],
    ['answers', './features/answers.js'],
    ['providers', './features/providers.js'],
    ['watch', './features/watch.js'],
  ]
  const features = []
  const failures = []
  for (const [id, rel] of spec) {
    try {
      const mod = await import(here(rel))
      if (!mod || typeof mod.createFeature !== 'function') throw new Error('缺少 createFeature 导出')
      features.push(mod)
    } catch (error) {
      failures.push({ id, message: String(error?.message ?? error) })
    }
  }
  return {
    createHostCompat: compatHost.createHostCompat,
    createLogger: compatHost.createLogger,
    describeCompat: compatFeatures.describe,
    TESTED_AGAINST: compatFeatures.TESTED_AGAINST,
    features,
    failures,
  }
}

export function resolveConfig(raw = {}, features = []) {
  const out = {}
  for (const mod of features) {
    const nested = raw[mod.id] && typeof raw[mod.id] === 'object' ? raw[mod.id] : {}
    const merged = { ...(mod.defaults || {}), ...nested }
    if (raw.enabled === false) merged.enabled = false
    out[mod.id] = merged
  }
  return out
}

export async function apply(ctx, rawConfig = {}) {
  const graph = await loadGraph()
  const FEATURES = graph.features
  const config = resolveConfig(rawConfig, FEATURES)
  const compat = graph.createHostCompat(ctx, { config: rawConfig, log: () => {} })
  const logFile = rawConfig.logFile
    ? String(rawConfig.logFile)
    : path.join(compat.core, 'probe.log')
  const log = graph.createLogger(logFile)
  compat.log = log

  // 逐项构造：某一块自己构造失败也只让那一块降级（构造里可能有外部依赖，例如引擎自检）。
  const features = []
  const degraded = [...(graph.failures || [])]
  for (const failure of graph.failures || []) {
    log({ type: 'feature-import-failed', id: failure.id, message: failure.message })
  }
  for (const mod of FEATURES) {
    try {
      features.push(mod.createFeature({ compat, config: config[mod.id], log }))
    } catch (error) {
      const message = String(error?.message ?? error)
      degraded.push({ id: mod.id, message })
      log({ type: 'feature-build-failed', id: mod.id, message })
    }
  }
  if (features.length === 0) throw new Error(`所有特性模块都起不来：${degraded.map(d => d.id).join(', ')}`)
  const byId = new Map(features.map(f => [f.id, f]))
  const routes = [`${BASE_PATH}/health`, `${BASE_PATH}/report`, ...features.flatMap(f => f.paths || [])]
  let lastReport = null

  async function handler(req, res) {
    let url
    try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { url = { pathname: '/', searchParams: new URLSearchParams() } }
    if (rejectForeignOrigin(req, res)) return
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }
    const pathname = url.pathname
    try {
      if (pathname === `${BASE_PATH}/health`) {
        compat.json(res, 200, {
          ...compat.health(),
          registry: graph.describeCompat(),
          testedAgainst: graph.TESTED_AGAINST,
          features: features.map(f => ({ id: f.id, title: f.title, enabled: config[f.id]?.enabled !== false })),
          degraded: degraded.map(d => ({ id: d.id, message: d.message })),
        })
        return
      }
      if (pathname === `${BASE_PATH}/report` && req.method === 'POST') {
        let body = {}
        try { body = JSON.parse(String(await compat.readBody(req)) || '{}') } catch { body = {} }
        const allowedStages = new Set(['paint-probe', 'dom-probe', 'tree-attached', 'first-data', 'fetch-empty', 'fetch-failed', 'seat', 'registered', 'slot-skipped-existing', 'slot-registered', 'slot-failed', 'no-slots'])
        const stage = allowedStages.has(body.stage) ? body.stage : 'unknown'
        const metrics = {}
        for (const key of ['rows', 'painted', 'matched', 'numbers', 'count', 'pending']) {
          if (Number.isSafeInteger(body[key]) && body[key] >= 0) metrics[key] = body[key]
        }
        lastReport = { at: new Date().toISOString(), stage, ...metrics }
        log({ type: 'client-report', stage, ...metrics })
        compat.json(res, 200, { ok: true, lastReport })
        return
      }
      const rest = pathname.startsWith(`${BASE_PATH}/`) ? pathname.slice(BASE_PATH.length + 1) : null
      const [id, action = 'state'] = rest ? rest.split('/') : []
      const feature = id ? byId.get(id) : null
      if (!feature) { compat.json(res, 404, { ok: false, error: '未知读数', path: pathname }); return }
      // 自带子树处理的 provider（例如待答：多条带 token 的路由）自己接管这一层。
      if (typeof feature.handle === 'function') { await feature.handle(req, res, rest, url); return }
      if (action === 'state') {
        const query = Object.fromEntries(url.searchParams?.entries?.() ?? [])
        compat.json(res, 200, feature.state(query))
        return
      }
      if (req.method !== 'POST') { compat.json(res, 405, { ok: false, error: '只接受 POST' }); return }
      let body = {}
      try { body = JSON.parse(String(await compat.readBody(req)) || '{}') } catch { body = {} }
      compat.json(res, 200, feature.action(action, body) ?? { ok: false, error: '无此动作' })
      return
    } catch (error) {
      log({ type: 'http-error', path: pathname, message: String(error?.message ?? error) })
      compat.json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  compat.whenService('webServer', web => {
    compat.mountRoute(web, BASE_PATH, routes, handler)
    log({ type: 'ready', port: web.port ?? null, pid: process.pid, routes: routes.length })
  })

  for (const feature of features) {
    try { feature.start?.() } catch (error) { log({ type: 'feature-start-error', id: feature.id, message: String(error?.message ?? error) }) }
  }
  log({ type: 'applied', features: features.map(f => f.id), log: logFile })

  return () => {
    for (const feature of features) { try { feature.dispose?.() } catch { /* ignore */ } }
    compat.dispose()
  }
}
