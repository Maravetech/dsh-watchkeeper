// 值守引擎 provider（值守台第三刀）—— 把原 `watchkeeper` 的宿主半搬进本包。
//
// 搬的是什么（逐字搬，行为不变）：
//   · 判断层代答：`user-questions/request` 认领提问、`session/event` 的 `turn/end` 读正文里的
//     `[DECISION_POINT]`、周期补扫；判断走 `.dsh/skills/jev/scripts/jev.py`。
//   · 三个回复 Provider：由 `lib/reply.js` 落到命令（codex / agy / custom），开关在 `lib/providers.js`。
//   · 红线转人工、租约、操作队列、证据留痕：`lib/watch/*`（lease / outbox / machine / evaluator / constraint-gate）。
//   · 对外服务名 `watchkeeper` **保持不变** —— 飞书 / 微信通道靠 `ctx.get('watchkeeper')` 取值守能力。
//
// 为什么默认 **不启用**（`enabled: false`）：现役的 `watchkeeper` 包仍在跑，两边同时接管会争同一份租约、
// 同一份状态目录，可能重复投递。切换顺序必须是：先把旧包的装配行撤下 → 再打开本开关 → 重启生效。
// 在那之前本 provider 是**惰性**的：不注册任何东西、不起任何定时器。

export const id = 'watch'
export const title = 'Watch engine'
export const paths = []
export const order = 40

export const defaults = {
  /** 默认随「现场有没有别的引擎」自动让位：显式 false 才彻底关（见 start()）。 */
  enabled: true,
  engine: {},
}

export function createFeature({ compat, config, log }) {
  let engineDisposer = null
  let stopWaitingForWebServer = null
  let engineError = null
  let started = false
  /** 引擎自己用 ctx.effect 挂清理（apply 不返回 disposer），所以「挂上了」要单独记。 */
  let mounted = false

  async function loadEngine() {
    const query = new URL(import.meta.url).search
    const url = new URL(`../watch/host.js${query}`, import.meta.url).href
    return import(url)
  }

  return {
    id,
    title,
    paths,
    order,
    start() {
      if (config.enabled === false) {
        log({ type: 'watch-engine-skipped', reason: 'enabled:false（配置显式关闭）' })
        return
      }
      // **自动让位**：现场已经有引擎提供了 `watchkeeper`（现役 watchkeeper 包还在）就先不接管 ——
      // 两边同时跑会争同一份租约、可能重复投递。旧包撤下后这里自然接手，不需要改配置。
      let existing = null
      try { existing = compat.ctx?.get?.('watchkeeper') ?? compat.ctx?.watchkeeper ?? null } catch { existing = null }
      if (existing) {
        log({ type: 'watch-engine-yielded', reason: 'another engine already provides watchkeeper' })
        return
      }
      started = true
      loadEngine()
        .then(engine => {
          const mount = (webServer) => {
            if (!webServer || typeof webServer.register !== 'function') {
              engineError = 'webServer service is missing register()'
              log({ type: 'watch-engine-failed', message: engineError })
              return
            }
            try {
              const disposer = engine.apply(
                compat.ctx,
                { ...(config.engine || {}), enabled: true },
                { webServer },
              )
              mounted = true
              if (typeof disposer === 'function') engineDisposer = disposer
              log({ type: 'watch-engine-mounted', revision: engine.CODE_REVISION ?? null })
            } catch (error) {
              engineError = String(error?.message ?? error)
              log({ type: 'watch-engine-failed', message: engineError })
            }
          }
          if (typeof compat.whenService === 'function') {
            stopWaitingForWebServer = compat.whenService('webServer', mount)
          } else {
            let webServer
            try { webServer = compat.ctx?.get?.('webServer') ?? compat.ctx?.webServer } catch { webServer = null }
            mount(webServer)
          }
        })
        .catch(error => {
          engineError = String(error?.message ?? error)
          log({ type: 'watch-engine-failed', message: engineError })
        })
    },
    dispose() {
      try { stopWaitingForWebServer?.() } catch { /* already released */ }
      stopWaitingForWebServer = null
      try { engineDisposer?.() } catch { /* ignore */ }
      engineDisposer = null
    },
    state() {
      return {
        ok: engineError === null,
        error: engineError || undefined,
        enabled: config.enabled !== false,
        started,
        mounted,
        service: 'watchkeeper',
        note: started ? undefined : 'another engine already provides watchkeeper; this provider yields',
      }
    },
    action(name) {
      return { ok: false, error: `未知动作：${name}` }
    },
  }
}
