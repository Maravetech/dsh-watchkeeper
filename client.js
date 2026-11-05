// 值守台（Watch Desk）—— 客户端半（包根 client.js，与 DSH 原生插件同款形状）。
//
// 第一刀只做**会话编号列**：侧边栏每个会话行最前面一个稳定编号，与浏览器标签页角标共用同一份台账。
//
// 为什么不用官方插槽 `sidebar.session.row.leading`：该插槽自己的目录说明写着
// 「A higher-priority state (a pending interaction, a new message, live activity) replaces the seat
//  with that dot for the same row … mounted only by a row whose primary state is idle」——
// 也就是**会话一忙、编号就没了**，而那正是最需要认号的时候。故按项目插件契约 §三 Level 2
// 「非侵入受管 DOM 放置」实现，守五项铁律：互斥锁 / 幂等挂载 / 防抖调度 / 自身变动豁免 / 作用域收敛。
//
// 其余规范与 status-dock 一致：不加载任何 Harness Client 包、不往 document.body 追加节点、
// 文案走 locale、样式只用主题 token；取不到号就不显示，绝不自己编号。

window.__ModuleLoader__.load({
  id: 'dsh-watchkeeper',
  factory: ((fn) => (require) => {
    // 加载兜底：只兜 factory 的同步加载失败。apply 保持原形态，
    // 激活期异常仍交给 cordis 记 FAILED（不掩盖真实错误）。
    try {
      return fn(require)
    } catch (error) {
      try {
        const list = (window.__dshDegradedPlugins ||= [])
        if (!list.includes("dsh-watchkeeper")) list.push("dsh-watchkeeper")
      } catch { /* 登记本身不能再抛 */ }
      try { window.dispatchEvent(new Event('dsh:plugin-degraded')) } catch { /* 无 window 环境 */ }
      console.error('[dsh-watchkeeper] 客户端 bundle 加载失败，已降级:', error)
      return { name: "dsh-watchkeeper", apply() {} }
    }
  })((require) => {
    const exports = {}

    let React
    try { React = require('react') } catch { React = null }
    if (!React?.createElement) return exports
    const h = React.createElement
    // Native button remains usable when optional primitives are absent.
    const Btn = 'button'

    // ═══════════════════════════ ① 适配层 ═══════════════════════════

    const ADAPTER_REVISION = 'watchkeeper/client-compat@1'

    const COMPAT = {
      basePath: '/watchkeeper',
      /** The question card renders under the assistant message. The watch switch
       *  and reply-provider switches live in the watch panel, not in the input row. */
      slots: [
        { name: 'conversation.chat.turnTail', id: 'watchkeeper-question-card', order: 90, component: () => TurnTail },
      ],
      numberPollMs: 20000,
      treeRetryMs: 1500,
      debounceMs: 120,
      rowSelector: '[data-row-key^="session:"]',
      treeSelector: '[role="tree"]',
      numberClass: 'cl-watchkeeper-num',
    }

    const TEXTS = {
      'numbers.title': 'Session numbers',
      'state.error': 'Failed to load',
      'duty.on': 'Watching',
      'duty.off': 'Off',
      'duty.tipOn': 'Watch is on: the judge answers mid-session questions; uncertain or red-line cases come to you',
      'duty.tipOff': 'Watch is off: click to let the judge take over this session',
      'duty.human': 'Questions are waiting for you',
      'duty.auto': 'answered by watchkeeper',
      'answers.needYou': 'Your answer is needed',
      'answers.pending': 'Pending',
      'answers.offline': 'Answer service not ready',
      'answers.cardBroken': 'The question card in this message was not registered, so the answer seat cannot show it',
      'answers.cardBrokenHint': 'You can answer here directly, or ask the agent to resend the card in the required format.',
      'answers.recommend': 'Suggested: ',
      'answers.why': 'Why: ',
      'answers.scope': 'Impact: ',
      'answers.placeholder': 'Answer directly',
      'answers.showDetail': 'Details',
      'answers.hideDetail': 'Hide details',
      'answers.stillUnclear': 'Still unclear',
      'answers.explaining': 'Explaining…',
      'answers.noDetail': 'No extra detail yet',
      'answers.explainPrompt': 'Explain this question in simpler words with one concrete example.',
      'answers.submit': 'Submit answer',
      'answers.submitAll': 'Submit all answers',
      'answers.submitting': 'Submitting…',
      'answers.submitted': 'Answer delivered; this session will continue',
      'answers.needOne': 'Answer at least one question first',
      'answers.saveFailed': 'Saving failed',
      'answers.submitFailed': 'Delivery failed',
      'providers.on': 'Click to turn off (currently taking over)',
      'providers.off': 'Click to turn on (take over replies)',
      'providers.failed': 'Toggle failed',
      'providers.offline': 'Reply provider switches: state unavailable (service not ready)',
    }

    function translate(t, key, vars) {
      const fallback = TEXTS[key] ?? key
      const template = (typeof t === 'function' ? (t(key) || fallback) : fallback)
      if (!vars) return template
      return String(template).replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? '' : String(vars[name])))
    }

    const TOKENS = {
      tertiary: 'var(--dsw-alias-label-tertiary, #8a8f98)',
      duty: 'var(--dsw-alias-brand-primary, #7c3aed)',
      ok: 'var(--dsw-alias-state-success, #1f9d55)',
      warn: 'var(--dsw-alias-state-warning, #b45309)',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
    }
    const OPTION_MARKS = ['①', '②', '③', '④']

    let resolvedBase = null

    function normalizeBase(value) { return String(value || '').replace(/\/$/, '') }

    function candidateBases() {
      const out = []
      try { if (typeof globalThis.__WATCHKEEPER_BASE_ === 'string') out.push(globalThis.__WATCHKEEPER_BASE_) } catch { /* ignore */ }
      try { const t = globalThis.__DSH_TRANSPORT__; if (t && t.streamBaseUrl) out.push(t.streamBaseUrl) } catch { /* ignore */ }
      try { const b = globalThis.__DSH_BOOT__; if (b && b.streamBaseUrl) out.push(b.streamBaseUrl) } catch { /* ignore */ }
      try { if (location.protocol === 'http:' || location.protocol === 'https:') out.push(location.origin) } catch { /* ignore */ }
      return [...new Set(out.filter(Boolean).map(normalizeBase))]
    }

    async function bootBases() {
      const out = candidateBases()
      try {
        const boot = globalThis.dshDesktopBoot
        if (boot && typeof boot.ready === 'function') {
          const info = await boot.ready()
          if (info && info.streamBaseUrl) out.push(normalizeBase(info.streamBaseUrl))
        }
      } catch { /* 桌面壳不可用时继续 */ }
      return [...new Set(out)]
    }

    async function probeBases() {
      const out = await bootBases()
      for (const port of [19387, 3080]) out.push(`http://127.0.0.1:${port}`)
      return [...new Set(out)]
    }

    async function getJson(path, init) {
      const bases = resolvedBase ? [resolvedBase, ...(await probeBases())] : await probeBases()
      for (const base of bases) {
        try {
          const res = await fetch(`${base}${path}`, { cache: 'no-store', ...(init || {}) })
          if (!res.ok) continue
          const data = await res.json()
          if (data && typeof data === 'object') { resolvedBase = base; return data }
        } catch { /* 换下一个基址 */ }
      }
      resolvedBase = null
      return null
    }

    function postJson(path, body) {
      return getJson(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    }

    function report(stage, extra) {
      try { void postJson(`${COMPAT.basePath}/report`, { stage, adapter: ADAPTER_REVISION, at: Date.now(), ...(extra || {}) }) } catch { /* 取证失败不影响界面 */ }
    }

    // ═══════════════════════════ ② 会话编号列 ═══════════════════════════

    const state = {
      numbers: {},
      timer: null,
      retry: null,
      observer: null,
      debounce: null,
      /** ① 变动互斥锁：自己插的那一列不再触发下一轮。 */
      isMutatingDom: false,
      /** ④ 自身变动豁免：只认不属于自己那一列的变动。 */
      ownNodes: new WeakSet(),
    }
    let disposed = false

    function css() {
      return `
        .${COMPAT.numberClass}{flex:none;display:inline-flex;align-items:center;justify-content:flex-end;
          min-width:20px;padding-right:3px;font-size:11px;line-height:1;
          font-variant-numeric:tabular-nums;font-weight:600;
          color:${TOKENS.tertiary};pointer-events:none;user-select:none}
        [data-watch-duty="1"]{position:relative}
        [data-watch-duty="1"]::before{content:'';position:absolute;left:2px;top:50%;width:5px;height:5px;
          margin-top:-2.5px;border-radius:50%;background:${TOKENS.duty};pointer-events:none}
        [data-watch-auto="1"]::after{content:attr(data-watch-chip);display:inline-flex;align-items:center;
          margin-right:6px;padding:0 6px;border-radius:999px;font-size:11px;line-height:18px;
          color:${TOKENS.duty};border:1px solid ${TOKENS.border};vertical-align:baseline}`
    }

    function insertStyle(ctx) {
      try {
        if (ctx?.styles && typeof ctx.styles.insert === 'function') { ctx.styles.insert(css()); return }
      } catch { /* 退回 <style> 元素 */ }
      const id = 'cl-watchdesk-style'
      try {
        if (document.getElementById(id)) return
        const el = document.createElement('style')
        el.id = id
        el.textContent = css()
        document.head.appendChild(el)
      } catch { /* ignore */ }
    }

    function sessionIdOf(row) {
      try {
        const key = row.getAttribute('data-row-key')
        return typeof key === 'string' && key.startsWith('session:') ? key.slice('session:'.length) : null
      } catch { return null }
    }

    /** ② 幂等挂载：已有这一列就只更新文本，绝不 remove 重建；没有号就不显示（不编造）。 */
    function paint() {
      let rows = []
      try { rows = Array.from(document.querySelectorAll(COMPAT.rowSelector)) } catch { return }
      state.lastPaint = { rows: rows.length, painted: 0, matched: 0 }
      for (const row of rows) {
        const sessionId = sessionIdOf(row)
        if (!sessionId) continue
        const entry = state.numbers[sessionId]
        const number = entry && entry.n != null ? String(entry.n) : null
        let existing = null
        try { existing = row.querySelector(`:scope > .${COMPAT.numberClass}`) } catch { existing = null }
        if (number == null) {
          if (existing && existing.isConnected) existing.remove()
          continue
        }
        try {
          const duty = state.duty?.[sessionId] === true
          if (duty) row.setAttribute('data-watch-duty', '1')
          else if (row.hasAttribute?.('data-watch-duty')) row.removeAttribute('data-watch-duty')
        } catch { /* 行上没有这个属性也不影响编号 */ }
        if (existing) {
          if (existing.textContent !== number) existing.textContent = number
          continue
        }
        try {
          if (!row.isConnected) continue
          const span = document.createElement('span')
          span.className = COMPAT.numberClass
          span.textContent = number
          span.title = `会话 ${number}`
          state.ownNodes.add(span)
          row.insertBefore(span, row.firstChild)
          state.lastPaint.painted += 1
        } catch { /* 行结构变了就跳过这一行 */ }
      }
      // 取证：行选择器到底命中几行、真的插了几列、第一行长什么样（只报前两次变动）。
      state.lastPaint.matched = rows.filter(row => { try { return row.querySelector(`:scope > .${COMPAT.numberClass}`) } catch { return false } }).length
      const signature = `${state.lastPaint.rows}/${state.lastPaint.painted}/${state.lastPaint.matched}`
      if (state.paintSignature !== signature && (state.paintReports || 0) < 4) {
        state.paintSignature = signature
        state.paintReports = (state.paintReports || 0) + 1
        let sample = null
        try {
          sample = rows[0] ? String(rows[0].outerHTML || '').slice(0, 240) : null
        } catch { sample = null }
        report('paint-probe', { ...state.lastPaint, sample, numbers: Object.keys(state.numbers).length })
      }
    }

    /** ③ 防抖调度：MutationObserver 回调里绝不同步改 DOM。 */
    function scheduleRender() {
      if (state.debounce) return
      state.debounce = setTimeout(() => {
        state.debounce = null
        state.isMutatingDom = true
        try { paint() } catch { /* ignore */ } finally { state.isMutatingDom = false }
      }, COMPAT.debounceMs)
    }

    function onMutation(records) {
      if (state.isMutatingDom) return
      // ④ 自身变动豁免：全是自己那一列的增删就直接返回。
      try {
        const onlyOurs = Array.isArray(records) && records.length > 0 && records.every(record => {
          const nodes = [...(record.addedNodes || []), ...(record.removedNodes || [])]
          return nodes.length > 0 && nodes.every(node => state.ownNodes.has(node) || (node.classList && node.classList.contains(COMPAT.numberClass)))
        })
        if (onlyOurs) return
      } catch { /* 判不出来就按普通变动处理 */ }
      scheduleRender()
    }

    /** ⑤ 作用域收敛：只观察会话树；树还没出现时低频重试，出现即停。 */
    function attachObserver() {
      if (disposed || state.observer) return
      let tree = null
      try { tree = document.querySelector(COMPAT.treeSelector) } catch { tree = null }
      if (!tree) {
        state.treeMisses = (state.treeMisses || 0) + 1
        // 取证：这一版侧栏的行结构到底长什么样（只报前三次，之后每 20 次报一次）。
        if (state.treeMisses <= 3 || state.treeMisses % 20 === 0) {
          let probe = {}
          try {
            const keyed = Array.from(document.querySelectorAll('[data-row-key]'))
            probe = {
              misses: state.treeMisses,
              dataRowKey: keyed.length,
              sessionRows: Array.from(document.querySelectorAll(COMPAT.rowSelector)).length,
              firstKeys: keyed.slice(0, 3).map(n => { try { return n.getAttribute('data-row-key') } catch { return null } }),
              roles: Array.from(new Set(Array.from(document.querySelectorAll('[role]')).slice(0, 200).map(n => { try { return n.getAttribute('role') } catch { return null } }))).slice(0, 12),
            }
          } catch { probe = { misses: state.treeMisses, error: 'probe-failed' } }
          report('dom-probe', probe)
        }
        if (!state.retry) {
          state.retry = setTimeout(() => { state.retry = null; attachObserver(); scheduleRender() }, COMPAT.treeRetryMs)
        }
        return
      }
      try {
        state.observer = new MutationObserver(onMutation)
        state.observer.observe(tree, { childList: true, subtree: true })
        report('tree-attached', { selector: COMPAT.treeSelector })
      } catch { /* 观察失败就只靠轮询 */ }
    }

    /** 值守状态：在**同一个心跳**里顺带取（多一个定时器会被组件治理口径与门禁拦下）。 */
    const dutyState = { value: null, listeners: new Set() }

    function notifyDuty() {
      for (const listener of dutyState.listeners) { try { listener(dutyState.value) } catch { /* ignore */ } }
    }

    async function refreshDuty() {
      try {
        const data = await getJson('/watchkeeper/watch/state')
        dutyState.value = data && typeof data === 'object' ? data : null
      } catch { dutyState.value = dutyState.value || null }
      notifyDuty()
      try { paintAutoReplies() } catch { /* 标记失败不影响读数 */ }
      return dutyState.value
    }

    /** 自动代答的气泡：打属性 + 用 CSS ::after 画前缀（不插节点、不改文案）。 */
    function paintAutoReplies() {
      const label = dutyState.value?.replyChipLabel || TEXTS['duty.auto']
      const rows = dutyState.value?.autoReplies || []
      const marked = new Set()
      for (const row of rows) {
        const id = typeof row === 'string' ? row : row?.id
        if (!id) continue
        let el = null
        try { el = document.querySelector(`[data-chat-flow-key="${String(id).replace(/"/g, '')}"]`) } catch { el = null }
        if (!el) continue
        el.setAttribute('data-watch-auto', '1')
        el.setAttribute('data-watch-chip', label)
        marked.add(el)
      }
      for (const el of document.querySelectorAll('[data-watch-auto="1"]')) {
        if (!marked.has(el)) { el.removeAttribute('data-watch-auto'); el.removeAttribute('data-watch-chip') }
      }
    }

    /** 订阅值守状态（首次调用时启动共享心跳；没有订阅者就停）。 */
    let dutyHeartbeat = null
    function subscribeDuty(listener) {
      dutyState.listeners.add(listener)
      try { listener(dutyState.value) } catch { /* ignore */ }
      if (dutyHeartbeat === null) {
        void refreshDuty()
        dutyHeartbeat = setInterval(() => { void refreshDuty() }, COMPAT.numberPollMs)
      }
      return () => {
        dutyState.listeners.delete(listener)
        if (dutyHeartbeat !== null && dutyState.listeners.size === 0) {
          clearInterval(dutyHeartbeat)
          dutyHeartbeat = null
        }
      }
    }

    async function refresh() {
      await refreshDuty()
      try {
        const data = await getJson(`${COMPAT.basePath}/numbers/state`)
        if (data && data.ok !== false && data.rows) {
          state.numbers = Object.fromEntries(data.rows.map(row => [row.sessionId, row]))
          if (!state.reported) { state.reported = true; report('first-data', { count: data.rows.length }) }
        } else {
          state.numbers = {}
          if (!state.fetchReported) { state.fetchReported = true; report('fetch-empty', { base: resolvedBase, payload: data ? Object.keys(data) : null }) }
        }
      } catch (error) {
        state.numbers = {}
        if (!state.fetchReported) { state.fetchReported = true; report('fetch-failed', { base: resolvedBase, message: String(error?.message ?? error) }) }
      }
      if (!disposed) scheduleRender()
    }

    function start(ctx) {
      if (disposed) return
      insertStyle(ctx)
      attachObserver()
      scheduleRender()
      void refresh()
      state.timer = setInterval(() => { attachObserver(); void refresh() }, COMPAT.pollMs || COMPAT.numberPollMs)
    }

    function stop() {
      disposed = true
      if (state.timer) { clearInterval(state.timer); state.timer = null }
      if (state.retry) { clearTimeout(state.retry); state.retry = null }
      if (state.debounce) { clearTimeout(state.debounce); state.debounce = null }
      try { state.observer?.disconnect() } catch { /* ignore */ }
      state.observer = null
      try {
        document.querySelectorAll(`.${COMPAT.numberClass}`).forEach(el => el.remove())
      } catch { /* ignore */ }
    }


    // ═══════════════════════════ ③ 待答（第二刀） ═══════════════════════════
    //
    // 一条链路：来源会话里的显式人工问题卡 → 登记（宿主半）→ 界面两处显示 → 你答 → 投回来源会话。
    // 座位：消息下方（conversation.chat.turnTail，就地答）。
    // 输入框上方的第二个座位已于 2026-10-19 撤销（与 codex-relay 的代理名开关重复）。**只显示本会话的问题**，不把别处的问题带进来。

    const ANSWERS = { base: '/watchkeeper/answers', pollMs: 30000 }
    let answersTokenCache = null
    // 「这条消息的卡为什么没登记上」按会话+轮次缓存：同一条消息只问一次。
    const cardProblemCache = new Map()

    function answersToken() {
      if (answersTokenCache) return answersTokenCache
      try {
        const injected = globalThis.__WATCHKEEPER_BASE_
        if (injected && injected.token) answersTokenCache = String(injected.token)
      } catch { /* ignore */ }
      return answersTokenCache
    }

    async function answersApi(route, { method = 'GET', payload, retry = true } = {}) {
      const headers = { 'content-type': 'application/json' }
      const current = answersToken()
      if (current) headers['x-watchkeeper-token'] = current
      const data = await getJson(`${ANSWERS.base}/${route}`, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}) })
      if (data) return data
      if (retry) {
        const conf = await getJson(`${ANSWERS.base}/config`)
        if (conf && conf.token) { answersTokenCache = String(conf.token); return answersApi(route, { method, payload, retry: false }) }
      }
      return null
    }

    function useAwaiting(sessionId) {
      const [rows, setRows] = React.useState([])
      const [notice, setNotice] = React.useState('')
      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        // 一次轮询失败不等于服务没起来：插件热重载、宿主换世代都会让单次 fetch 落空。
        // 2026-10-30 排查：旧代码只要失败一次就把「待答服务未就绪」永久挂在卡上，
        // 之后哪怕服务恢复也不会消失（成功后从不清 notice），界面看起来一直坏着。
        // 现在：连续 2 次失败才报，成功后立刻清除，失败后 2 秒先快速重试一次。
        let failures = 0
        let quickRetry = null
        const tick = async () => {
          const data = await answersApi(`awaiting?sessionId=${encodeURIComponent(sessionId)}`)
          if (!alive) return
          const items = data?.data?.items
          if (Array.isArray(items)) {
            failures = 0
            setRows(items)
            setNotice('')
          } else if (data === null) {
            failures += 1
            if (failures >= 2) setNotice(TEXTS['answers.offline'])
            else if (!quickRetry) {
              quickRetry = setTimeout(() => { quickRetry = null; if (alive) void tick() }, 2000)
            }
          }
        }
        void tick()
        const timer = setInterval(() => { void tick() }, ANSWERS.pollMs)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])
      return { rows, setRows, notice, setNotice }
    }

    function AnswerField({ row, value, onChange, onExplain }) {
      const [show, setShow] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [detail, setDetail] = React.useState('')
      async function explain() {
        setBusy(true)
        try {
          const data = await onExplain(row)
          setDetail(data?.data?.explanations?.at(-1)?.text || TEXTS['answers.noDetail'])
        } catch (error) {
          setDetail(String(error?.message ?? error))
        } finally { setBusy(false); setShow(true) }
      }
      const fallback = [row.reason && `${TEXTS['answers.why']}${row.reason}`, row.blockingScope && `${TEXTS['answers.scope']}${row.blockingScope}`].filter(Boolean).join('\n')
      return h('section', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderTop: `1px solid ${TOKENS.border}` } }, [
        h('strong', { key: 'q', style: { fontWeight: 600 } }, row.question),
        row.recommendation ? h('small', { key: 'rec', style: { opacity: 0.75 } }, `${TEXTS['answers.recommend']}${row.recommendation}`) : null,
        // 选项直接点：点一下把答案填进下面的输入框（还能改），不用自己照着抄。
        (Array.isArray(row.options) && row.options.length)
          ? h('div', { key: 'opts', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            row.options.map((option, index) => h(Btn, {
              key: 'opt' + index,
              type: 'button',
              onClick: () => onChange(option),
              'aria-pressed': value === option,
              style: {
                textAlign: 'left', padding: '6px 10px', borderRadius: 8, cursor: 'pointer', font: 'inherit', color: 'inherit',
                background: value === option ? 'var(--dsw-alias-bg-layer-2, rgba(124,58,237,.12))' : 'transparent',
                border: `1px solid ${value === option ? TOKENS.duty : TOKENS.border}`,
              },
            }, `${OPTION_MARKS[index] || ''} ${option}`)))
          : null,
        h('textarea', {
          key: 'a', rows: 3, value, maxLength: 12000, placeholder: TEXTS['answers.placeholder'], 'aria-label': row.question,
          onChange: event => onChange(event.target.value),
          style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: 8, color: 'inherit', background: 'var(--dsw-alias-bg-layer-1, transparent)', border: `1px solid ${TOKENS.border}`, borderRadius: 8, font: 'inherit' },
        }),
        h('div', { key: 'actions', style: { display: 'flex', gap: 8, alignItems: 'center' } }, [
          h(Btn, { key: 'why', onClick: () => setShow(!show) }, show ? TEXTS['answers.hideDetail'] : TEXTS['answers.showDetail']),
          h(Btn, { key: 'explain', disabled: busy, onClick: explain }, busy ? TEXTS['answers.explaining'] : TEXTS['answers.stillUnclear']),
        ]),
        show ? h('div', { key: 'detail', style: { padding: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1, transparent)', whiteSpace: 'pre-wrap', fontSize: 'inherit' } }, detail || fallback) : null,
      ])
    }

    function useQuestionSubmit(sessionId) {
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      async function submit(rows, answers, reload) {
        setBusy(true); setNotice('')
        try {
          const items = []
          for (const row of rows) {
            const answer = String(answers[row.id] || '').trim()
            if (!answer) continue
            let saved = row
            if (answer !== (row.answer || '')) {
              const res = await answersApi('save', { method: 'POST', payload: { id: row.id, version: row.version, answer, deferred: false } })
              if (!res?.ok) throw Error(res?.error || TEXTS['answers.saveFailed'])
              saved = res.data
            }
            if (saved.version !== saved.submittedVersion) items.push({ id: saved.id, version: saved.version })
          }
          if (!items.length) throw Error(TEXTS['answers.needOne'])
          const res = await answersApi('submit', { method: 'POST', payload: { sessionId, items } })
          if (!res?.ok) throw Error(res?.error || TEXTS['answers.submitFailed'])
          setNotice(TEXTS['answers.submitted'])
          if (reload) await reload()
        } catch (error) {
          setNotice(String(error?.message ?? error))
        } finally { setBusy(false) }
      }
      return { busy, notice, submit }
    }

    /** 座位①：消息下方的问题卡（就地答）。 */
    function TurnTail(props) {
      const sessionId = props?.sessionId
      const seq = props?.seq
      const { rows, setRows, notice, setNotice } = useAwaiting(sessionId)
      const [answers, setAnswers] = React.useState({})
      const submitter = useQuestionSubmit(sessionId)
      const mine = rows.filter(row => !seq || String(row.messageId || '') === String(seq))
      // 一条都没登记上时，问一次「这条消息有没有出过卡、为什么没收」——问题不能静默消失。
      const [problems, setProblems] = React.useState([])
      React.useEffect(() => {
        if (!seq || mine.length) { setProblems([]); return undefined }
        const key = `${sessionId}:${seq}`
        const cached = cardProblemCache.get(key)
        if (cached) { setProblems(cached); return undefined }
        let alive = true
        void (async () => {
          const res = await answersApi('message', { method: 'POST', payload: { sessionId, seq } })
          if (!alive || !Array.isArray(res?.data?.problems)) return
          // 同一条消息只问一次（每条助手消息都会挂一个座位，别把 inspect 打成轮询）。
          if (cardProblemCache.size >= 200) cardProblemCache.delete(cardProblemCache.keys().next().value)
          cardProblemCache.set(key, res.data.problems)
          setProblems(res.data.problems)
        })()
        return () => { alive = false }
      }, [sessionId, seq, mine.length])
      React.useEffect(() => {
        setAnswers(Object.fromEntries(mine.map(row => [row.id, row.answer || ''])))
      }, [mine.map(row => `${row.id}:${row.version}`).join(',')])
      React.useEffect(() => { if (rows.length) report('seat', { seat: 'turn-tail', pending: rows.length }) }, [rows.length])
      if (!mine.length && !notice && !problems.length) return null
      async function reload() {
        const data = await answersApi(`awaiting?sessionId=${encodeURIComponent(sessionId)}`)
        if (Array.isArray(data?.data?.items)) setRows(data.data.items)
      }
      return h('div', {
        'data-watchkeeper': 'question-card',
        style: { width: '100%', marginTop: 8, padding: 12, boxSizing: 'border-box', border: `1px solid ${TOKENS.border}`, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 6 },
      }, [
        mine.length ? h('strong', { key: 'head' }, mine.length > 1 ? `${TEXTS['answers.needYou']} · ${mine.length}` : TEXTS['answers.needYou']) : null,
        problems.length ? h('div', { key: 'broken', role: 'alert', style: { display: 'flex', flexDirection: 'column', gap: 2, padding: 8, borderRadius: 8, border: `1px solid ${TOKENS.warn}` } }, [
          h('strong', { key: 't' }, TEXTS['answers.cardBroken']),
          ...problems.map((text, index) => h('div', { key: 'p' + index, style: { opacity: 0.85 } }, text)),
          h('small', { key: 'h', style: { opacity: 0.7 } }, TEXTS['answers.cardBrokenHint']),
        ]) : null,
        ...mine.map(row => h(AnswerField, {
          key: row.id, row, value: answers[row.id] || '',
          onChange: value => setAnswers(old => ({ ...old, [row.id]: value })),
          onExplain: async target => answersApi('explain', { method: 'POST', payload: { id: target.id, question: TEXTS['answers.explainPrompt'] } }),
        })),
        mine.length ? h('div', { key: 'submit', style: { display: 'flex', justifyContent: 'flex-end' } },
          h(Btn, { disabled: submitter.busy, onClick: () => submitter.submit(mine, answers, reload) }, submitter.busy ? TEXTS['answers.submitting'] : TEXTS['answers.submit'])) : null,
        (submitter.notice || notice) ? h('small', { key: 'notice', role: 'status' }, submitter.notice || notice) : null,
      ])
    }


    // ═══════════════════════════ 注册 ═══════════════════════════

    exports.inject = []

    exports.inject = ['slots']

    exports.apply = (ctx, config) => {
      if (config?.enabled === false) return () => {}
      report('registered', { adapter: ADAPTER_REVISION })
      const disposers = []

      // ① 会话编号列（受管 DOM，守五项铁律）——生命周期：能挂 ctx.effect 就挂，挂了之后仍要显式 start()
      //    （effect 的返回值是清理函数，不会被立刻调用；踩过一次，单测有断言盯它）。
      try {
        if (typeof ctx?.effect === 'function') ctx.effect(() => { start(ctx); return stop })
        else { try { ctx?.on?.('dispose', stop) } catch { /* ignore */ } start(ctx) }
      } catch { try { start(ctx) } catch { /* ignore */ } }
      disposers.push(() => stop())

      // ② 待答座位（官方插槽）：消息下方的问题卡；输入框上方那条值守行已于 2026-10-19 撤掉
      const slots = (() => { try { return ctx?.get?.('slots') ?? ctx?.slots } catch { return undefined } })()
      // 挂载幂等（契约五项铁律之一）：热重载会把上一版实例的条目留在插槽里，
      // 同 id 再注册一次就会出现「两条一样的」或「旧那条失活」。注册前先查同 id。
      const hasEntry = (slotName, id) => {
        try {
          const read = slots.entriesOfSlot || slots.entries
          if (typeof read !== 'function') return false
          const list = read.call(slots, slotName) || []
          return [...list].some(entry => (entry?.options?.id ?? entry?.id) === id)
        } catch { return false }
      }
      if (slots && typeof slots.register === 'function') {
        for (const seat of COMPAT.slots) {
          if (hasEntry(seat.name, seat.id)) {
            report('slot-skipped-existing', { slot: seat.name, id: seat.id })
            continue
          }
          try {
            const off = typeof slots.inject === 'function'
              ? slots.inject(seat.name, () => slots.register({ name: seat.name, id: seat.id, order: seat.order, label: seat.label }, seat.component()))
              : slots.register({ name: seat.name, id: seat.id, order: seat.order, label: seat.label }, seat.component())
            if (typeof off === 'function') disposers.push(off)
            report('slot-registered', { slot: seat.name, id: seat.id })
          } catch (error) {
            report('slot-failed', { slot: seat.name, message: String(error?.message ?? error) })
          }
        }
      } else {
        report('no-slots')
      }

      return () => { for (const off of disposers.reverse()) { try { off() } catch { /* ignore */ } } }
    }

    exports.__internals = { COMPAT, TEXTS, translate, candidateBases, paint, scheduleRender, state, stop, TurnTail, answersApi, duty: dutyState }

    return exports
  }),
})
