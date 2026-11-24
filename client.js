/**
 * JEVHarness client module — Conversation Node extension (official path).
 *
 * Host writes durable log-only session events ('jev/decision', 'jev/gate').
 * This module registers a Conversation Node Definition that folds those events
 * into one node per turn and renders it inline in the chat, plus a header HUD,
 * an input pill and a right-sidebar deep-decision tab (chunk ladder + rule hits).
 * No custom /api or rpc transport.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-jevharness-preset',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const KIND = 'jev-harness'
    const SIDEBAR_ID = '@local/dsh-jevharness-preset/sidebar'
    const SIDEBAR_KIND = 'jev-harness-decisions'
    const MODE_KEY = 'jev-harness.displayMode'
    const MODES = ['live', 'compact', 'showcase']
    const MODE_LABEL = { live: '实时', compact: '精简', showcase: '演示' }

    function log() { try { if (typeof console !== 'undefined') console.info.apply(console, ['[JEVHarness]'].concat(Array.prototype.slice.call(arguments))) } catch (e) { /* ignore */ } }

    let clientCtx = null
    let stylesInjected = false
    function ensureStyles() {
      if (stylesInjected || typeof document === 'undefined') return
      stylesInjected = true
      const css = [
        '@keyframes jevPulse{0%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1)}100%{opacity:.35;transform:scale(.82)}}',
        '.jev-hud{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:12px;border:1px solid rgba(124,92,255,.45);background:linear-gradient(180deg,rgba(124,92,255,.16),rgba(124,92,255,.06));color:#cdbfff;font:600 11px/1 ui-monospace,Consolas,monospace;cursor:pointer;user-select:none}',
        '.jev-dot{width:7px;height:7px;border-radius:50%;background:#7c5cff;box-shadow:0 0 8px #7c5cff;animation:jevPulse 1.4s ease-in-out infinite}',
        '.jev-sep{opacity:.4}.jev-badge-deny{color:#f85149;font-weight:700}',
        '.jev-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;margin-right:8px;border-radius:13px;border:1px solid rgba(124,92,255,.4);background:rgba(124,92,255,.1);color:#cdbfff;font:600 11px/1 ui-monospace,Consolas,monospace;cursor:pointer}',
        '.jev-card{margin:8px auto;max-width:640px;max-height:220px;overflow-x:hidden;overflow-y:auto;border:1px solid rgba(124,92,255,.28);border-radius:10px;background:var(--dsw-alias-bg-elevated,#171c23);font-size:12px}',
        '.jev-card-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(90deg,rgba(124,92,255,.18),transparent);flex-wrap:wrap}',
        '.jev-card-title{font-weight:700;color:#cdbfff;font-size:12px}',
        '.jev-card-sub{color:var(--dsw-alias-fg-secondary,#a9b4c0);font-size:11px}',
        '.jev-row{display:flex;align-items:center;gap:6px;padding:4px 12px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-fg-secondary,#a9b4c0);flex-wrap:wrap}',
        '.jev-row b{color:var(--dsw-alias-fg,#e8edf3);font-weight:600}',
        '.jev-tag{display:inline-block;padding:1px 6px;border-radius:5px;font-size:10px;font-weight:600}',
        '.jev-tag-deny{background:rgba(248,81,73,.16);color:#f85149}',
        '.jev-tag-ask{background:rgba(210,153,34,.16);color:#d29922}',
        '.jev-tag-ok{background:rgba(63,185,80,.14);color:#3fb950}',
        '.jev-kv{display:flex;flex-wrap:wrap;gap:6px;padding:6px 12px 10px}',
        '.jev-kv span{background:rgba(124,92,255,.1);border:1px solid rgba(124,92,255,.22);border-radius:6px;padding:2px 7px;font-family:ui-monospace,Consolas,monospace;font-size:10.5px;color:#cdbfff}',
        '.jev-shield{display:flex;align-items:center;gap:8px;margin:6px 10px;padding:7px 10px;border-radius:8px;border:1px solid rgba(248,81,73,.5);background:linear-gradient(90deg,rgba(248,81,73,.22),rgba(248,81,73,.05));color:#ffb3ad;font-size:12px;font-weight:600;flex-wrap:wrap}',
        '.jev-shield-ic{font-size:15px;filter:drop-shadow(0 0 4px rgba(248,81,73,.6))}',
        '.jev-metric{display:inline-flex;padding:1px 7px;border-radius:6px;background:rgba(63,185,80,.12);color:#7ee787;font-size:10.5px;font-weight:600;font-family:ui-monospace,Consolas,monospace}',
        '.jev-brand{margin-top:2px;padding:5px 10px;border-top:1px dashed rgba(124,92,255,.3);color:#cdbfff;font:600 10.5px/1.4 ui-monospace,Consolas,monospace;opacity:.9}',
        '.jev-deep-card{max-height:none;overflow:visible}',
        '.jev-deep-title{padding:9px 12px 2px;font-weight:700;color:#cdbfff}',
        '.jev-deep-head{display:flex;align-items:center;gap:8px;padding-bottom:10px;border-bottom:1px solid rgba(124,92,255,.25);font-weight:700;color:#cdbfff;flex-wrap:wrap}',
        '.jev-deep-sec{margin-top:10px;padding:10px 12px;border-radius:6px;background:rgba(124,92,255,.05)}',
        '.jev-rule-example{margin-top:4px;font-size:10.5px;color:#7ee787}',
        '.jev-flow{margin-top:10px;padding:10px 12px;border-radius:6px;background:rgba(124,92,255,.05)}',
        '.jev-flow svg{width:100%;height:auto;display:block}',
        '.jev-deep-sec h4{margin:0 0 8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-fg-secondary,#a9b4c0)}',
        '.jev-ladder{display:flex;gap:3px;height:14px;border-radius:6px;overflow:hidden;background:rgba(124,92,255,.08)}',
        '.jev-ladder-seg{display:inline-flex;align-items:center;justify-content:center;min-width:18px;font:700 9px/1 ui-monospace,Consolas,monospace;color:#0d1117}',
        '.jev-lvl-hide{background:#6e7681}.jev-lvl-short{background:#d29922}.jev-lvl-long{background:#58a6ff}.jev-lvl-full{background:#3fb950}',
        '.jev-legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:7px;font-size:10.5px;color:var(--dsw-alias-fg-secondary,#a9b4c0)}',
        '.jev-legend-item{display:inline-flex;align-items:center;gap:4px}',
        '.jev-swatch{display:inline-block;width:8px;height:8px;border-radius:2px}',
        '.jev-chunks{margin-top:8px;display:flex;flex-direction:column;gap:4px}',
        '.jev-chunk{display:flex;align-items:center;gap:7px;padding:5px 8px;border:1px solid rgba(124,92,255,.18);border-radius:6px;background:rgba(124,92,255,.05);flex-wrap:wrap}',
        '.jev-chunk-src{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-fg-secondary,#a9b4c0);font-size:10.5px}',
        '.jev-rules{margin-top:8px;display:flex;flex-direction:column;gap:6px}',
        '.jev-rule{padding:7px 9px;border-left:2px solid #d29922;border-radius:4px;background:rgba(210,153,34,.07);display:flex;flex-direction:column;gap:3px}',
        '.jev-rule-reason{font-size:10.5px;color:var(--dsw-alias-fg-secondary,#a9b4c0)}',
        '.jev-empty{padding:10px;border:1px dashed rgba(124,92,255,.22);border-radius:6px;color:var(--dsw-alias-fg-secondary,#a9b4c0);font-size:11px}',
        '.jev-dock{width:100%;margin:0 0 6px;display:flex;justify-content:center}',
        '.jev-dock-sticky{position:sticky;bottom:0;z-index:6;backdrop-filter:blur(6px)}',
        '.jev-dock-sub{color:var(--dsw-alias-fg-secondary,#a9b4c0);font-weight:500}',
        '.jev-receipt-wrap{margin:8px 0}',
      ].join('\n')
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', '@local/dsh-jevharness-preset')
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---- display mode ----
    const modeListeners = new Set()
    let mode = readMode()
    function readMode() { try { const v = window.localStorage.getItem(MODE_KEY); return (v === 'live' || v === 'compact' || v === 'showcase') ? v : 'live' } catch (e) { return 'live' } }
    function getMode() { return mode }
    function setMode(m) { mode = m; try { window.localStorage.setItem(MODE_KEY, m) } catch (e) { /* ignore */ } for (const fn of modeListeners) { try { fn() } catch (e) { /* ignore */ } } }
    function useMode() { const [, f] = React.useState(0); React.useEffect(() => { const fn = () => f((x) => x + 1); modeListeners.add(fn); return () => { modeListeners.delete(fn) } }, []); return getMode() }
    function cycleMode() { setMode(MODES[(MODES.indexOf(getMode()) + 1) % MODES.length]) }

    // ---- latest-state store for HUD / pill ----
    const hud = { latest: null, listeners: new Set() }
    // Settled state drives the governance receipt. A 4s idle debounce guarantees
    // the receipt appears after the turn stops even if host turn/end is missing.
    const settled = { mode: false, snap: null, listeners: new Set() }
    let idleTimer = null
    function settleNow(s) {
      settled.snap = s ? Object.assign({}, s) : null
      settled.mode = !!settled.snap
      for (const fn of settled.listeners) { try { fn() } catch (e) { /* ignore */ } }
    }
    function touchActivity(s) {
      settled.mode = false
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
      idleTimer = setTimeout(() => { settleNow(hud.latest); idleTimer = null }, 4000)
      for (const fn of settled.listeners) { try { fn() } catch (e) { /* ignore */ } }
    }
    function useSettled() { const [, f] = React.useState(0); React.useEffect(() => { const fn = () => f((x) => x + 1); settled.listeners.add(fn); return () => { settled.listeners.delete(fn) } }, []); return settled }
    function hudSet(s) { hud.latest = s; touchActivity(s); for (const fn of hud.listeners) { try { fn() } catch (e) { /* ignore */ } } }
    function useHud() { const [, f] = React.useState(0); React.useEffect(() => { const fn = () => f((x) => x + 1); hud.listeners.add(fn); return () => { hud.listeners.delete(fn) } }, []); return hud.latest }

    // ---- state fold ----
    function initState(ev) {
      const turn = ev.data && typeof ev.data.turn === 'number' ? ev.data.turn : 0
      return { turn: turn, decisions: ev.type === 'jev/decision' ? [ev.data] : [], gates: ev.type === 'jev/gate' ? [ev.data] : [], chunkLadder: (ev.data && ev.data.chunkLadder) || [], ruleHits: (ev.data && ev.data.ruleHits) || [] }
    }
    function foldState(state, ev) {
      const s = state || { turn: 0, decisions: [], gates: [], chunkLadder: [], ruleHits: [] }
      const turn = ev.data && typeof ev.data.turn === 'number' ? ev.data.turn : s.turn
      if (ev.type === 'jev/decision') {
        const step = ev.data && ev.data.step
        const decisions = s.decisions.filter(function (d) { return step === undefined || d.step !== step }).concat([ev.data])
        return { turn: turn, decisions: decisions, gates: s.gates, chunkLadder: ev.data.chunkLadder || s.chunkLadder, ruleHits: ev.data.ruleHits || s.ruleHits }
      }
      return { turn: turn, decisions: s.decisions, gates: s.gates.concat([ev.data]), chunkLadder: s.chunkLadder, ruleHits: s.ruleHits }
    }

    const definition = {
      kind: KIND,
      target: 'chat',
      match: function (event) {
        if (event && (event.type === 'jev/decision' || event.type === 'jev/gate')) {
          const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : 0
          return { id: 't' + turn, role: 'start' }
        }
        return null
      },
      start: function (_context, match) { const s = initState(match.event); hudSet(s); return s },
      update: function (context, match) { const s = foldState(context && context.state, match.event); hudSet(s); return s },
      publication: function () { return 'immediate' },
      // Live state is projected into conversation.input.dock at the bottom of
      // the conversation. The Definition still folds events, but must not anchor
      // a card at the first decision (top), where it scrolls out of view.
      buildViewNode: function () { return null },
    }

    // Turn-end governance receipt: a separate Definition anchored on turn/end,
    // so the card lands at the bottom of the conversation after the turn closes.
    const RECEIPT_KIND = KIND + '-receipt'
    const receiptDefinition = {
      kind: RECEIPT_KIND,
      target: 'chat',
      match: function (event) {
        if (event && (event.type === 'turn/end' || event.type === 'jev/receipt')) {
          const d = event.data || {}
          const turn = typeof d.turn === 'number' ? d.turn : (typeof event.turn === 'number' ? event.turn : 0)
          return { id: 'r' + turn, role: 'start' }
        }
        return null
      },
      start: function () { const s = Object.assign({}, hud.latest || { turn: 0, decisions: [], gates: [] }); s.endedAt = Date.now(); settleNow(s); return s },
      update: function (context, match) {
        const s = Object.assign({}, hud.latest || (context && context.state) || { turn: 0, decisions: [], gates: [] })
        s.turn = match && match.event && match.event.data && typeof match.event.data.turn === 'number' ? match.event.data.turn : s.turn
        s.endedAt = Date.now()
        settleNow(s)
        return s
      },
      publication: function () { return 'immediate' },
      buildViewNode: function (context) {
        if (!context || context.state === undefined) return null
        const m = (context.start && context.start.match) || context.start || (context.matches && context.matches[0]) || null
        const anchor = (m && m.event && m.event.seq) || 0
        const loc = (m && m.location) || { kind: 'unresolved' }
        return { key: context.key, kind: RECEIPT_KIND, id: context.id, target: 'chat', anchorSeq: anchor, location: loc, visibility: 'visible', data: context.state }
      },
    }

    function fmtTok(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) }
    function JevCard(props) {
      React.useEffect(() => { ensureStyles() }, [])
      const s = props.state || { turn: 0, decisions: [], gates: [] }
      const m = props.mode || 'live'
      const decs = s.decisions || []
      const gates = s.gates || []
      const last = decs.length ? decs[decs.length - 1] : null
      const denyGates = gates.filter((g) => g.verdict === 'deny')
      const savedT = decs.reduce((a, d) => a + (typeof d.savedTokens === 'number' ? d.savedTokens : 0), 0)
      const reuseN = decs.filter((d) => d.cacheFrozen).length
      const reuseRate = decs.length ? Math.round((reuseN / decs.length) * 100) : 0
      const lat = last && typeof last.latencyMs === 'number' ? Math.round(last.latencyMs) : null
      const head = h('div', { className: 'jev-card-head' },
        h('span', { className: 'jev-card-title' }, props && props.receipt ? 'JEV 治理回执' : 'JEV 实时介入'),
        h('span', { className: 'jev-dot' }),
        h('span', { className: 'jev-card-sub' }, '· ' + decs.length + ' 步决策' + (gates.length ? ' · ' + gates.length + ' 次拦截' : '') + (lat !== null ? ' · ' + lat + 'ms' : '')),
        denyGates.length ? h('span', { className: 'jev-tag jev-tag-deny' }, '拦截') : null)
      const shield = denyGates.length ? h('div', { className: 'jev-shield' },
        h('span', { className: 'jev-shield-ic' }, '🛡'),
        h('span', null, 'JEVHarness 已拦截 ' + denyGates.length + ' 次：' + (denyGates[0].ruleId || 'policy')),
        denyGates[0].reason ? h('span', { className: 'jev-card-sub' }, '— ' + String(denyGates[0].reason).slice(0, 90)) : null) : null
      // Step-flow projection: only the latest decision and the latest gate.
      // The head count still reports totals, so the card never grows with history.
      const rows = []
      if (last) {
        const L = last.lines || {}
        rows.push(h('div', { key: 'd' + (last.step || 0), className: 'jev-row' },
          h('span', { className: 'jev-tag jev-tag-ok' }, '#' + last.step),
          h('span', null, 'vis='), h('b', null, L.context_visibility || '?'),
          h('span', null, '· cache='), h('b', null, L.cache || '?'),
          h('span', null, '· route='), h('b', null, L.routing || '?'),
          h('span', null, '· tools='), h('b', null, L.tools || '?'),
          last.cacheFrozen ? h('span', { className: 'jev-tag jev-tag-ok' }, 'KV复用') : null))
      }
      const lastGate = gates.length ? gates[gates.length - 1] : null
      if (lastGate) {
        rows.push(h('div', { key: 'g' + (lastGate.step || 0), className: 'jev-row' },
          h('span', { className: 'jev-tag ' + (lastGate.verdict === 'deny' ? 'jev-tag-deny' : 'jev-tag-ask') }, lastGate.verdict),
          h('b', null, lastGate.toolName || 'tool'), h('span', null, '· ' + (lastGate.ruleId || ''))))
      }
      const metrics = h('div', { className: 'jev-kv' },
        h('span', { className: 'jev-metric' }, 'KV 复用率 ' + reuseRate + '%'),
        h('span', { className: 'jev-metric' }, '省约 ' + fmtTok(savedT) + ' tokens'),
        h('span', { className: 'jev-metric' }, '决策 ' + decs.length + ' · 拦截 ' + gates.length))
      const brand = m === 'showcase' ? h('div', { className: 'jev-brand' }, '⚡ Powered by JEVHarness · 实时六维治理 · ' + decs.length + ' 步决策 / ' + gates.length + ' 次拦截 / 省约 ' + fmtTok(savedT) + ' tokens') : null
      return h('div', { className: 'jev-card' }, head, shield, rows, metrics, brand)
    }

    function JevReceiptView(props) {
      const s = (props && props.node && props.node.data) || null
      return h('div', { className: 'jev-receipt-wrap' }, h(JevCard, { state: s, mode: getMode(), receipt: true }))
    }
    function JevHud() {
      React.useEffect(() => { ensureStyles() }, [])
      const s = useHud()
      useMode()
      if (!s || (!s.decisions.length && !s.gates.length)) return null
      const last = s.decisions.length ? s.decisions[s.decisions.length - 1] : null
      const step = last && typeof last.step === 'number' ? last.step : null
      const lat = last && typeof last.latencyMs === 'number' ? Math.round(last.latencyMs) : null
      const denies = s.gates.filter((g) => g.verdict === 'deny').length
      return h('span', { className: 'jev-hud', title: '点击打开 JEV 深度决策台（右侧栏）', onClick: openDeepPanel },
        h('span', { className: 'jev-dot' }), h('span', null, 'JEV Live'),
        step !== null ? h('span', { className: 'jev-sep' }, '·') : null,
        step !== null ? h('span', null, 'Step #' + step) : null,
        lat !== null ? h('span', { className: 'jev-sep' }, '·') : null,
        lat !== null ? h('span', null, lat + 'ms') : null,
        denies > 0 ? h('span', { className: 'jev-badge-deny' }, ' ⛊ ' + denies) : null)
    }
    function JevPill() {
      React.useEffect(() => { ensureStyles() }, [])
      const s = useHud()
      const m = useMode()
      if (!s || (!s.decisions.length && !s.gates.length)) return null
      return h('button', { type: 'button', className: 'jev-pill', onClick: cycleMode }, h('span', { className: 'jev-dot' }), 'JEV 六维 · ' + MODE_LABEL[m])
    }

    // HUD opens the dedicated right-sidebar decision console; the input pill
    // keeps cycling the display mode (live / compact / showcase).
    function openDeepPanel() {
      try {
        if (clientCtx && clientCtx.sidebarRight && typeof clientCtx.sidebarRight.openTab === 'function') {
          clientCtx.sidebarRight.openTab(SIDEBAR_KIND)
          return
        }
      } catch (e) { /* fall through to mode cycling */ }
      cycleMode()
    }

    const LADDER = [
      { key: 'hide', label: '隐藏', cls: 'hide', desc: '不送进模型，最省 token' },
      { key: 'short_summary', label: '短摘要', cls: 'short', desc: '压到约 240 字，只留要点' },
      { key: 'long_summary', label: '长摘要', cls: 'long', desc: '压到约 1200 字，保留细节' },
      { key: 'full', label: '全文', cls: 'full', desc: '完整交给模型阅读' },
    ]
    // Six decisions, each with a plain-language explanation for non-experts.
    const DIMENSIONS = [
      { key: 'context_visibility', label: '上下文', desc: '每份资料给模型看多少' },
      { key: 'cache', label: '缓存', desc: '能否复用上一步的 KV Cache' },
      { key: 'routing', label: '路由', desc: '这一步交给哪档模型处理' },
      { key: 'tools', label: '工具', desc: '给模型展示多少工具说明' },
      { key: 'permissions', label: '权限', desc: '工具调用是否放行' },
      { key: 'security', label: '安全', desc: '信息敏感级别与外发限制' },
    ]
    const VALUE_LABEL = {
      hide: '隐藏', short_summary: '短摘要', long_summary: '长摘要', full: '全文',
      reuse: '复用缓存', rebuild: '重建缓存', frontier: '前沿模型', cheap: '轻量模型',
      background: '后台模型', targeted: '按需加载', full_read: '全部加载',
      search_source: '检索加载', allow: '放行', ask: '需确认', deny: '拒绝',
      public: '公开', internal: '内部', sensitive: '敏感', secret: '机密',
    }
    function valueLabel(v) { return VALUE_LABEL[v] || v || '未定' }
    // Turn a rule's match reason into a concrete, human-readable example.
    function ruleExample(r) {
      const reason = String((r && r.reason) || '')
      if (/always/i.test(reason)) return '例如：每一步都会自动加载这条规则'
      const paths = reason.match(/paths:([^;]+)/)
      if (paths) return '例如：读到 ' + paths[1].split(',')[0].trim() + ' 下的文件时加载'
      const keywords = reason.match(/keywords:([^;]+)/)
      if (keywords) return '例如：内容出现「' + keywords[1].split(',')[0].trim() + '」时加载'
      const tools = reason.match(/tools:([^;]+)/)
      if (tools) return '例如：调用 ' + tools[1].split(',')[0].trim() + ' 类工具时加载'
      return '例如：本回合的活跃路径或内容触发了这条规则'
    }
    function JevDeepPanel(props) {
      React.useEffect(() => { ensureStyles() }, [])
      const useTabInfo = props && props.hooks && props.hooks.tabInfo
      const info = useTabInfo ? useTabInfo() : null
      const s = useHud() || { turn: 0, decisions: [], gates: [], chunkLadder: [], ruleHits: [] }
      const decs = s.decisions || []
      const gates = s.gates || []
      const chunks = s.chunkLadder || []
      const rules = s.ruleHits || []
      const last = decs.length ? decs[decs.length - 1] : null
      const L = (last && last.lines) || {}
      const denyGates = gates.filter((g) => g.verdict === 'deny')
      const savedT = decs.reduce((a, d) => a + (typeof d.savedTokens === 'number' ? d.savedTokens : 0), 0)
      const reuseRate = decs.length ? Math.round((decs.filter((d) => d.cacheFrozen).length / decs.length) * 100) : 0
      const counts = {}
      for (const x of LADDER) counts[x.key] = 0
      for (const c of chunks) { if (counts[c.visibility] !== undefined) counts[c.visibility] += 1 }
      const total = chunks.length || 1
      const fullscreen = info && info.sidebar && info.sidebar.fullscreen ? ' · 全屏' : ''

      const head = h('div', { className: 'jev-card-head' },
        h('span', { className: 'jev-card-title' }, 'JEV 深度决策台'),
        h('span', { className: 'jev-dot' }),
        h('span', { className: 'jev-card-sub' }, ' · 本回合 ' + decs.length + ' 步治理决策的明细' + (denyGates.length ? ' · 拦截 ' + denyGates.length + ' 次' : '') + fullscreen),
        denyGates.length ? h('span', { className: 'jev-tag jev-tag-deny' }, '拦截') : null)
      const shield = denyGates.length ? h('div', { className: 'jev-shield' },
        h('span', { className: 'jev-shield-ic' }, '🛡'),
        h('span', null, 'JEVHarness 已拦截 ' + denyGates.length + ' 次：' + (denyGates[0].ruleId || 'policy')),
        denyGates[0].reason ? h('span', { className: 'jev-card-sub' }, '— ' + String(denyGates[0].reason).slice(0, 90)) : null) : null

      const dimRows = DIMENSIONS.map((d) => h('div', { key: d.key, className: 'jev-row' },
        h('span', { className: 'jev-tag jev-tag-ok' }, d.label),
        h('b', null, valueLabel(L[d.key])),
        h('span', { className: 'jev-card-sub' }, '— ' + d.desc)))

      const ladderSec = h('div', { className: 'jev-deep-sec' },
        h('div', { className: 'jev-row' }, h('b', null, '上下文处理'),
          h('span', { className: 'jev-card-sub' }, '— 共 ' + chunks.length + ' 份资料，按重要性决定给模型看多少')),
        h('div', { className: 'jev-ladder' }, LADDER.map((x) => counts[x.key]
          ? h('span', { key: x.key, className: 'jev-ladder-seg jev-lvl-' + x.cls, style: { flex: String(counts[x.key] / total) }, title: x.label + ' ' + counts[x.key] + ' 份' }, String(counts[x.key]))
          : null)),
        h('div', { className: 'jev-legend' }, LADDER.map((x) => h('span', { key: x.key, className: 'jev-legend-item' },
          h('i', { className: 'jev-swatch jev-lvl-' + x.cls }), x.label + ' ' + counts[x.key] + ' 份 · ' + x.desc))))

      const ruleSec = h('div', { className: 'jev-deep-sec' },
        h('div', { className: 'jev-row' }, h('b', null, '命中规则 (' + rules.length + ')'),
          h('span', { className: 'jev-card-sub' }, '— 本回合自动加载的项目规范')),
        rules.length
          ? h('div', { className: 'jev-rules' }, rules.map((r) => h('div', { key: r.id, className: 'jev-rule' },
              h('b', null, r.name || r.id),
              h('span', { className: 'jev-card-sub' }, r.source || ''),
              h('div', { className: 'jev-rule-reason' }, '命中原因：' + (r.reason || '路径或关键词匹配')),
              h('div', { className: 'jev-rule-example' }, ruleExample(r)))))
          : h('div', { className: 'jev-empty' }, '本回合没有命中条件规则（路径或关键词未触发）'))

      // Data flow — compact inline version of .tmp/answers/jev-data-flow.html.
      // Same five stages, same JEV skin, orthogonal connectors, one focal arrow.
      const flowNodes = [
        ['采集', '会话事件', '#a9b4c0'],
        ['决策', '六维 JeV', '#a78bfa'],
        ['裁剪', '可见阶梯', '#a9b4c0'],
        ['投影', '旁路事件', '#a9b4c0'],
        ['呈现', '三处 UI', '#58a6ff'],
      ]
      const flowSec = h('div', { className: 'jev-flow' },
        h('div', { className: 'jev-row' }, h('b', null, '数据流'), h('span', { className: 'jev-card-sub' }, '— 只走 UI 旁路，不进模型 prompt')),
        h('svg', { viewBox: '0 0 600 96', xmlns: 'http://www.w3.org/2000/svg', role: 'img', 'aria-label': '从会话事件到决策台的五段数据流' },
          h('defs', null, h('marker', { id: 'jevFlowArrow', markerWidth: 6, markerHeight: 6, refX: 5, refY: 3, orient: 'auto' },
            h('polygon', { points: '0 0, 6 3, 0 6', fill: '#a9b4c0' }))),
          flowNodes.map(function (n, i) {
            const x = 8 + i * 118
            return h('g', { key: 'f' + i },
              i ? h('line', { x1: x - 12, y1: 48, x2: x - 2, y2: 48, stroke: '#a9b4c0', strokeWidth: 1, markerEnd: 'url(#jevFlowArrow)' }) : null,
              h('rect', { x: x, y: 22, width: 100, height: 52, rx: 6, fill: '#171c23', stroke: n[2] }),
              h('text', { x: x + 50, y: 42, textAnchor: 'middle', fontSize: 11, fontWeight: 600, fill: n[2] }, n[1]),
              h('text', { x: x + 50, y: 60, textAnchor: 'middle', fontSize: 9, fill: '#a9b4c0' }, n[0]))
          })))

      const metrics = h('div', { className: 'jev-kv' },
        h('span', { className: 'jev-metric' }, 'KV 复用率 ' + reuseRate + '%'),
        h('span', { className: 'jev-metric' }, '省约 ' + fmtTok(savedT) + ' tokens'),
        h('span', { className: 'jev-metric' }, '决策 ' + decs.length + ' · 拦截 ' + gates.length))
      const brand = getMode() === 'showcase' ? h('div', { className: 'jev-brand' }, '⚡ Powered by JEVHarness · 实时六维治理 · 本回合省约 ' + fmtTok(savedT) + ' tokens') : null

      return h('div', { className: 'jev-card jev-deep-card' },
        head, shield,
        h('div', { className: 'jev-deep-title' }, '六步决策 · 逐项说明'), dimRows,
        ladderSec, flowSec, ruleSec, metrics, brand)
    }

    // Bottom-of-conversation live projection. conversation.input.dock is a
    // full-width list above the composer, so the card stays visible as the
    // conversation grows; it never scrolls away at the top.
    function JevLiveDock() {
      React.useEffect(() => { ensureStyles() }, [])
      const live = useHud()
      const st = useSettled()
      const m = useMode()
      const receiptMode = st.mode && st.snap && st.snap.decisions && st.snap.decisions.length > 0
      const s = receiptMode ? st.snap : live
      if (!s || (!s.decisions.length && !s.gates.length)) return null
      // Full Phase 2 card in the bottom dock. Step-flow rows stay capped; once
      // the turn settles it switches to the governance receipt in the same spot.
      return h('div', { className: 'jev-dock jev-dock-sticky' }, h(JevCard, { state: s, mode: m, receipt: !!receiptMode }))
    }

    return {
      inject: ['uiConversation', 'slots', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        clientCtx = ctx || null
        try { if (typeof window !== 'undefined') window.__JEV_CLIENT_LOADED__ = true } catch (e) { /* ignore */ }
        try { ensureStyles() } catch (e) { /* ignore */ }
        log('apply, uiConversation=', !!(ctx && ctx.uiConversation), 'slots=', !!(ctx && ctx.slots))
        try { ctx.uiConversation.events.register(definition); log('node definition registered') } catch (e) { log('node definition FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.uiConversation.events.register(receiptDefinition); log('receipt definition registered') } catch (e) { log('receipt definition FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'jev-harness-live-dock', order: 30 }, JevLiveDock)); log('input.dock slot registered') } catch (e) { log('input.dock slot FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: RECEIPT_KIND }, JevReceiptView)); log('chat.node receipt slot registered') } catch (e) { log('chat.node slot FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'jev-harness-hud', order: 40 }, JevHud)); log('hud slot registered') } catch (e) { log('hud slot FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'jev-harness-pill', order: 90 }, JevPill)); log('pill slot registered') } catch (e) { log('pill slot FAILED', String(e && e.message ? e.message : e)) }
        // Phase 3: dedicated right-sidebar tab — chunk ladder + conditional rule hits.
        // Two-stage registration follows the official sidebarRightTabs contract:
        // a static type declaration plus a keyed slot body, both disposed with ctx.
        try {
          if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
            const register = () => ctx.sidebarRightTabs.register({
              id: SIDEBAR_ID,
              kind: SIDEBAR_KIND,
              keepMounted: true,
              title: () => 'JEV 决策台',
              guide: [{
                id: 'jev-deep-decisions',
                order: 20,
                title: () => 'JEV 决策台',
                description: () => 'Chunk 可见性阶梯 · 条件规则命中 · 六维决策',
              }],
            })
            if (typeof ctx.effect === 'function') {
              ctx.effect(() => {
                const d = register()
                return () => { try { if (typeof d === 'function') d(); else if (d && typeof d.dispose === 'function') d.dispose() } catch (e) { /* ignore */ } }
              })
            } else {
              register()
            }
            log('sidebarRightTabs registered')
          }
        } catch (e) { log('sidebarRightTabs FAILED', String(e && e.message ? e.message : e)) }
        try {
          if (ctx.slots && typeof ctx.slots.inject === 'function') {
            ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_ID }, JevDeepPanel))
            log('sidebar.right.pane.tab slot registered')
          }
        } catch (e) { log('sidebar pane tab slot FAILED', String(e && e.message ? e.message : e)) }
      },
    }
  },
})
