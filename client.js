/**
 * JEVHarness client module — Conversation Node extension (official path).
 *
 * Host writes durable log-only session events ('jev/decision', 'jev/gate').
 * This module registers a Conversation Node Definition that folds those events
 * into one node per turn and renders it inline in the chat, plus a header HUD and
 * an input pill driven by a small module store. No custom /api or rpc transport.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-jevharness-preset',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const KIND = 'jev-harness'
    const MODE_KEY = 'jev-harness.displayMode'
    const MODES = ['live', 'compact', 'showcase']
    const MODE_LABEL = { live: '实时', compact: '精简', showcase: '演示' }

    function log() { try { if (typeof console !== 'undefined') console.info.apply(console, ['[JEVHarness]'].concat(Array.prototype.slice.call(arguments))) } catch (e) { /* ignore */ } }

    let stylesInjected = false
    function ensureStyles() {
      if (stylesInjected || typeof document === 'undefined') return
      stylesInjected = true
      const css = [
        '@keyframes jevPulse{0%{opacity:.35;transform:scale(.82)}50%{opacity:1;transform:scale(1)}100%{opacity:.35;transform:scale(.82)}}',
        '.jev-hud{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:12px;border:1px solid rgba(124,92,255,.45);background:linear-gradient(180deg,rgba(124,92,255,.16),rgba(124,92,255,.06));color:#cdbfff;font:600 11px/1 ui-monospace,Consolas,monospace;cursor:pointer;user-select:none}',
        '.jev-dot{width:7px;height:7px;border-radius:50%;background:#7c5cff;box-shadow:0 0 8px #7c5cff;animation:jevPulse 1.4s ease-in-out infinite}',
        '.jev-sep{opacity:.4}.jev-badge-deny{color:#f85149;font-weight:700}',
        '.jev-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:13px;border:1px solid rgba(124,92,255,.4);background:rgba(124,92,255,.1);color:#cdbfff;font:600 11px/1 ui-monospace,Consolas,monospace;cursor:pointer}',
        '.jev-card{margin:8px 0;border:1px solid rgba(124,92,255,.28);border-radius:10px;background:var(--dsw-alias-bg-elevated,#171c23);overflow:hidden;font-size:12px}',
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
        '.jev-shield-ic{font-size:15px}',
        '.jev-metric{display:inline-flex;padding:1px 7px;border-radius:6px;background:rgba(63,185,80,.12);color:#7ee787;font-size:10.5px;font-weight:600;font-family:ui-monospace,Consolas,monospace}',
        '.jev-brand{margin-top:2px;padding:5px 10px;border-top:1px dashed rgba(124,92,255,.3);color:#cdbfff;font:600 10.5px/1.4 ui-monospace,Consolas,monospace;opacity:.9}',
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
    function hudSet(s) { hud.latest = s; for (const fn of hud.listeners) { try { fn() } catch (e) { /* ignore */ } } }
    function useHud() { const [, f] = React.useState(0); React.useEffect(() => { const fn = () => f((x) => x + 1); hud.listeners.add(fn); return () => { hud.listeners.delete(fn) } }, []); return hud.latest }

    // ---- state fold ----
    function initState(ev) {
      const turn = ev.data && typeof ev.data.turn === 'number' ? ev.data.turn : 0
      return { turn: turn, decisions: ev.type === 'jev/decision' ? [ev.data] : [], gates: ev.type === 'jev/gate' ? [ev.data] : [] }
    }
    function foldState(state, ev) {
      const s = state || { turn: 0, decisions: [], gates: [] }
      const turn = ev.data && typeof ev.data.turn === 'number' ? ev.data.turn : s.turn
      if (ev.type === 'jev/decision') { const step = ev.data && ev.data.step; const decisions = s.decisions.filter(function (d) { return step === undefined || d.step !== step }).concat([ev.data]); return { turn: turn, decisions: decisions, gates: s.gates } }
      return { turn: turn, decisions: s.decisions, gates: s.gates.concat([ev.data]) }
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
      buildViewNode: function (context) {
        if (!context || context.state === undefined) return null
        const loc = (context.start && context.start.location) || (context.matches && context.matches[0] && context.matches[0].location) || { kind: 'unresolved' }
        const anchor = (context.start && context.start.event && context.start.event.seq) || (context.matches && context.matches[0] && context.matches[0].event && context.matches[0].event.seq) || 0
        return { key: context.key, kind: KIND, id: context.id, target: 'chat', anchorSeq: anchor, location: loc, visibility: 'visible', data: context.state }
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
        h('span', { className: 'jev-card-title' }, 'JEV 实时介入'),
        h('span', { className: 'jev-dot' }),
        h('span', { className: 'jev-card-sub' }, '· ' + decs.length + ' 步决策' + (gates.length ? ' · ' + gates.length + ' 次拦截' : '') + (lat !== null ? ' · ' + lat + 'ms' : '')),
        denyGates.length ? h('span', { className: 'jev-tag jev-tag-deny' }, '拦截') : null)
      const shield = denyGates.length ? h('div', { className: 'jev-shield' },
        h('span', { className: 'jev-shield-ic' }, '🛡'),
        h('span', null, 'JEVHarness 已拦截 ' + denyGates.length + ' 次：' + (denyGates[0].ruleId || 'policy')),
        denyGates[0].reason ? h('span', { className: 'jev-card-sub' }, '— ' + String(denyGates[0].reason).slice(0, 90)) : null) : null
      const rows = []
      for (const d of decs) {
        const L = d.lines || {}
        rows.push(h('div', { key: 'd' + (d.step || 0) + '-' + rows.length, className: 'jev-row' },
          h('span', { className: 'jev-tag jev-tag-ok' }, '#' + d.step),
          h('span', null, 'vis='), h('b', null, L.context_visibility || '?'),
          h('span', null, '· cache='), h('b', null, L.cache || '?'),
          h('span', null, '· route='), h('b', null, L.routing || '?'),
          h('span', null, '· tools='), h('b', null, L.tools || '?'),
          d.cacheFrozen ? h('span', { className: 'jev-tag jev-tag-ok' }, 'KV复用') : null))
      }
      for (const g of gates) {
        rows.push(h('div', { key: 'g' + rows.length, className: 'jev-row' },
          h('span', { className: 'jev-tag ' + (g.verdict === 'deny' ? 'jev-tag-deny' : 'jev-tag-ask') }, g.verdict),
          h('b', null, g.toolName || 'tool'), h('span', null, '· ' + (g.ruleId || ''))))
      }
      const metrics = h('div', { className: 'jev-kv' },
        h('span', { className: 'jev-metric' }, 'KV 复用率 ' + reuseRate + '%'),
        h('span', { className: 'jev-metric' }, '省约 ' + fmtTok(savedT) + ' tokens'),
        h('span', { className: 'jev-metric' }, '决策 ' + decs.length + ' · 拦截 ' + gates.length))
      const brand = m === 'showcase' ? h('div', { className: 'jev-brand' }, '⚡ Powered by JEVHarness · 实时六维治理 · ' + decs.length + ' 步决策 / ' + gates.length + ' 次拦截 / 省约 ' + fmtTok(savedT) + ' tokens') : null
      return h('div', { className: 'jev-card' }, head, shield, rows, metrics, brand)
    }

    function JevNodeView(props) {
      return h(JevCard, { state: props && props.node && props.node.data })
    }
    function JevHud() {
      React.useEffect(() => { ensureStyles() }, [])
      const s = useHud()
      useMode()
      if (!s || (!s.decisions.length && !s.gates.length)) return null
      const last = s.decisions.length ? s.decisions[s.decisions.length - 1] : null
      const step = last && typeof last.step === 'number' ? last.step : null
      const denies = s.gates.filter((g) => g.verdict === 'deny').length
      return h('span', { className: 'jev-hud', title: 'JEVHarness 实时介入', onClick: cycleMode },
        h('span', { className: 'jev-dot' }), h('span', null, 'JEV Live'),
        step !== null ? h('span', { className: 'jev-sep' }, '·') : null,
        step !== null ? h('span', null, 'Step #' + step) : null,
        denies > 0 ? h('span', { className: 'jev-badge-deny' }, ' ⛊ ' + denies) : null)
    }
    function JevPill() {
      React.useEffect(() => { ensureStyles() }, [])
      const s = useHud()
      const m = useMode()
      if (!s || (!s.decisions.length && !s.gates.length)) return null
      return h('button', { type: 'button', className: 'jev-pill', onClick: cycleMode }, h('span', { className: 'jev-dot' }), 'JEV 六维 · ' + MODE_LABEL[m])
    }

    return {
      inject: ['uiConversation', 'slots'],
      apply(ctx) {
        try { if (typeof window !== 'undefined') window.__JEV_CLIENT_LOADED__ = true } catch (e) { /* ignore */ }
        try { ensureStyles() } catch (e) { /* ignore */ }
        log('apply, uiConversation=', !!(ctx && ctx.uiConversation), 'slots=', !!(ctx && ctx.slots))
        try { ctx.uiConversation.events.register(definition); log('node definition registered') } catch (e) { log('node definition FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: KIND }, JevNodeView)); log('conversation.chat.node slot registered') } catch (e) { log('chat.node slot FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'jev-harness-hud', order: 40 }, JevHud)); log('hud slot registered') } catch (e) { log('hud slot FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'jev-harness-pill', order: 90 }, JevPill)); log('pill slot registered') } catch (e) { log('pill slot FAILED', String(e && e.message ? e.message : e)) }
      },
    }
  },
})
