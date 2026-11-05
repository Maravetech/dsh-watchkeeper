// 版本适配登记表 —— 全插件**唯一**随 DeepSeek Harness 版本改动的地方。
//
// 目的（the operator 2026-10-15）：DSH 升级后不必重造每个插件，只改这一份登记表 +
// 运行探测（lib/compat/host.js 的 health 报告），其余代码只依赖本表导出的抽象。
//
// 纪律：
//   1. 这里只写**事实**（哪个版本实测过、哪些名字在哪个版本存在），不写愿望；
//   2. 每一项都要有 fallback（拿不到就降级，不抛、不瘫主链路）；
//   3. 运行期实测到的能力覆盖静态登记：health 报告里 `observed` 优先于 `declared`。

/** 本文档实测过的宿主/客户端版本（跑过 `--dump-config` 与真机界面的版本）。 */
export const TESTED_AGAINST = ['0.2.1-alpha.3', '0.2.0-rc.2']

/**
 * 宿主面适配表。
 * - `acquire`：拿到服务的优先级链（先官方推荐写法，再兼容旧写法）。
 * - `optional: true` 表示缺失时必须降级而不是阻断。
 */
export const HOST = {
  services: {
    webServer: {
      optional: false,
      acquire: ['inject', 'get', 'property'],
      methods: { register: 'register', origin: 'getOrigin' },
    },
    // cordis-plugin-timer：新版本有就用它（自动随 fiber 回收），没有就退回 setInterval。
    timer: { optional: true, acquire: ['inject', 'get', 'property'], methods: { interval: 'interval', timeout: 'timeout' } },
  },
  /** 路由形状：`register({kind, path, handler})`；kind 只认这两种。 */
  route: { kinds: ['exact', 'prefix'], collision: 'throw' },
  /** 生命周期：ctx.effect 是官方写法；ctx.on('dispose') 实测在宿主侧不触发（只作最后兜底）。 */
  lifecycle: { effect: 'ctx.effect', fallback: "ctx.on('dispose')" },
  /**
   * 用到的宿主事件与它们的模式（模式取自 0.2.1-alpha.3 的 Event 目录实测）。
   * emit = 只观察；waterfall = 必须包 next() 并原样委派。
   */
  events: {
    'session/event': 'emit',
    'api-session/status': 'emit',
    'agent/status': 'emit',
    'llm/stream': 'waterfall',
    'tools/execute': 'waterfall',
    'approval/request': 'waterfall',
    'user-questions/request': 'waterfall',
    'webserver/index-inject': 'emit',
    'app-boot/config-reload': 'emit',
  },
}

/** 客户端面适配表。 */
export const CLIENT = {
  /** 平台基线模块（浏览器模块表自带，只登记 dsh.client.inject，不写 external）。 */
  baselineModules: ['react', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-slots'],
  /** 可选增强模块：拿不到就自绘，不阻断激活。 */
  optionalModules: ['react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  /** 状态行落点。官方语义：输入框下方环境条目（additive，replaceRisk: none）。 */
  slots: {
    dock: 'conversation.composer.dock',
    /** 备选落点（dock 消失时按顺序试；都拿不到就不显示，不抛）。 */
    fallbacks: ['conversation.input.dock'],
  },
  /**
   * 外观跟随原生：字体/尺寸一律取官方状态行胶囊的表达式与 token，
   * 取不到才用括号里的兜底值。**不写死 px、不写字面色值。**
   */
  style: {
    fontFamily: 'inherit',
    fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
    lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    pillPadding: '1px 8px',
    pillRadius: '999px',
    panelFontSize: 'var(--dsh-content-font-size-secondary, 12px)',
    panelLineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    panelRadius: 'var(--dsw-radius-lg, 12px)',
    tokens: {
      idle: 'var(--dsw-alias-label-tertiary, #8a8f98)',
      normal: 'var(--dsw-alias-label-secondary, #5f6570)',
      ok: 'var(--dsw-alias-state-success, #1f9d55)',
      warn: 'var(--dsw-alias-state-warn, #d9822b)',
      error: 'var(--dsw-alias-state-error, #d64545)',
      layer: 'var(--dsw-alias-bg-layer-1, transparent)',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.25))',
    },
  },
}

/**
 * 允许的降级姿态：任何一项拿不到时的对外表现。
 * 判据是「照实说」——显示未知/无法取数，绝不补零、绝不猜。
 */
export const DEGRADE = {
  hostServiceMissing: { ok: false, error: '服务不可用', hint: '宿主半没拿到所需服务' },
  scriptMissing: { ok: false, error: '脚本不可用' },
  scriptTimeout: { ok: false, error: '脚本超时' },
  noData: { ok: false, error: '未读到数据' },
  disabled: { ok: false, error: '已停用（enabled: false）' },
}

/** 组装成一份可读的登记表（health 报告用）。 */
export function describe() {
  return {
    testedAgainst: TESTED_AGAINST,
    hostServices: Object.keys(HOST.services),
    hostEvents: Object.keys(HOST.events),
    clientSlots: [CLIENT.slots.dock, ...CLIENT.slots.fallbacks],
    degrade: Object.keys(DEGRADE),
  }
}
