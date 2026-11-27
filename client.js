/**
 * JEVHarness client module — single top-bar HUD with a floating governance receipt.
 *
 * The host writes durable log-only session events ('jev/decision', 'jev/gate').
 * One node Definition folds them into per-turn state; a header HUD shows live
 * metrics. Clicking the HUD opens a floating terminal-style receipt window.
 * No inline cards, no input pill, no sidebar tab, no custom /api transport.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-jevharness-preset',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const KIND = 'jev-harness'

    function log() { try { if (typeof console !== 'undefined') console.info.apply(console, ['[JEVHarness]'].concat(Array.prototype.slice.call(arguments))) } catch (e) { /* ignore */ } }

    let clientCtx = null
    let activeSessionId = null
    let stylesInjected = false
    function ensureStyles() {
      if (stylesInjected || typeof document === 'undefined') return
      stylesInjected = true
      const css = [
        '@keyframes jevPulse{0%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}100%{opacity:.35;transform:scale(.8)}}',
        '@keyframes jevBlink{0%,100%{opacity:1}50%{opacity:.35}}',
        '.jev-hud-wrap{position:relative;display:inline-flex;align-items:center}',
        '.jev-hud{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:1px solid #9dbf3c;border-radius:2px;background:#0b0e0b;color:#d6f75a;font:700 11px/1 ui-monospace,Consolas,monospace;letter-spacing:.08em;cursor:pointer;user-select:none;clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100% - 6px))}',
        '.jev-hud:hover{background:#141a10;box-shadow:0 0 12px rgba(214,247,90,.35)}',
        '.jev-dot{width:7px;height:7px;border-radius:50%;background:#d6f75a;box-shadow:0 0 8px #d6f75a;animation:jevPulse 1.4s ease-in-out infinite;flex:0 0 auto}',
        '.jev-sep{color:#5d6b52}.jev-badge-deny{color:#ff5a4d;font-weight:700}',
        '.jev-pop{position:fixed;width:420px;max-width:calc(100vw - 24px);max-height:min(78vh,720px);overflow:auto;z-index:2147483000;box-sizing:border-box;color:#cfe0bd;background:repeating-linear-gradient(0deg,rgba(214,247,90,.028) 0 1px,transparent 1px 3px),#090c0a;border:1px solid #9dbf3c;box-shadow:0 18px 60px rgba(0,0,0,.75),0 0 0 1px rgba(214,247,90,.12),0 0 26px rgba(214,247,90,.12);font:12px/1.5 ui-monospace,Consolas,monospace;clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,12px 100%,0 calc(100% - 12px))}',
        '.jev-pop::before{content:"";position:absolute;inset:5px;border:1px solid rgba(214,247,90,.18);pointer-events:none}',
        '.jev-pop-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(90deg,rgba(214,247,90,.12),rgba(214,247,90,.02));border-bottom:1px solid rgba(214,247,90,.32)}',
        '.jev-pop-title{font-weight:800;letter-spacing:.14em;color:#d6f75a;white-space:nowrap}',
        '.jev-barcode{flex:1;height:20px;min-width:20px;opacity:.65;background:repeating-linear-gradient(90deg,#d6f75a 0 1px,transparent 1px 3px,#d6f75a 3px 4px,transparent 4px 7px,#d6f75a 7px 9px,transparent 9px 12px)}',
        '.jev-live{padding:2px 6px;border:1px solid #d6f75a;background:#d6f75a;color:#0b0e0b;font-weight:800;font-size:10px;letter-spacing:.12em;animation:jevBlink 2s ease-in-out infinite}',
        '.jev-pop-body{padding:10px 12px 12px}',
        '.jev-tiles{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid rgba(214,247,90,.22);margin-bottom:10px}',
        '.jev-tile{min-height:54px;padding:6px 8px;border-right:1px solid rgba(214,247,90,.18);border-bottom:1px solid rgba(214,247,90,.18);display:flex;flex-direction:column;gap:3px}',
        '.jev-tile:nth-child(3n){border-right:0}.jev-tile:nth-last-child(-n+3){border-bottom:0}',
        '.jev-tile-label{font-size:9px;letter-spacing:.16em;color:#7f906f;text-transform:uppercase}',
        '.jev-tile-value{font-size:16px;font-weight:800;color:#d6f75a;line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.jev-tile-value.amber{color:#ffb000}.jev-tile-value.red{color:#ff5a4d}',
        '.jev-instrument{display:flex;gap:10px;align-items:stretch;margin-bottom:10px}',
        '.jev-gauge-box{flex:0 0 132px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(214,247,90,.22);background:rgba(214,247,90,.04)}',
        '.jev-chart-box{flex:1;min-width:0;border:1px solid rgba(214,247,90,.22);background:rgba(214,247,90,.04);padding:4px 6px}',
        '.jev-box-label{font-size:9px;letter-spacing:.14em;color:#7f906f;margin-bottom:2px}',
        '.jev-alert{padding:8px 10px;margin-bottom:10px;border:1px dashed #ff5a4d;background:rgba(255,74,51,.08);color:#ff8b80}',
        '.jev-alert.ok{border-color:#9dbf3c;background:rgba(214,247,90,.06);color:#d6f75a}',
        '.jev-alert-title{font-weight:800;letter-spacing:.12em;margin-bottom:3px}',
        '.jev-stream{max-height:132px;overflow:auto;border:1px solid rgba(214,247,90,.2);margin-bottom:10px}',
        '.jev-stream-row{display:flex;gap:8px;padding:3px 8px;border-bottom:1px dashed rgba(214,247,90,.12);font-size:11px;white-space:nowrap}',
        '.jev-stream-row b{color:#d6f75a;font-weight:700}.jev-stream-row .amber{color:#ffb000}',
        '.jev-foot{border-top:1px solid rgba(214,247,90,.28);padding-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:space-between}',
        '.jev-metric{padding:2px 6px;border:1px solid rgba(214,247,90,.28);color:#d6f75a;font-size:10.5px}',
        '.jev-btn{padding:4px 10px;border:1px solid #9dbf3c;background:#d6f75a;color:#0b0e0b;font:800 10px/1 ui-monospace,Consolas,monospace;letter-spacing:.1em;cursor:pointer}',
        '.jev-btn.ghost{background:transparent;color:#d6f75a}',
        '.jev-foot-note{width:100%;color:#7f906f;font-size:10px;letter-spacing:.06em}',
        '.jev-foot-note em{color:#ffb000;font-style:normal}',
      ].join('\n')
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin', '@local/dsh-jevharness-preset')
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---- settled state: receipt snapshot after the turn goes idle ----
    const hud = { latest: null, listeners: new Set() }
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
    function hudSet(s) { hud.latest = enrichState(s); touchActivity(s); for (const fn of hud.listeners) { try { fn() } catch (e) { /* ignore */ } } }
    function useHud() { const [, f] = React.useState(0); React.useEffect(() => { const fn = () => f((x) => x + 1); hud.listeners.add(fn); return () => { hud.listeners.delete(fn) } }, []); return hud.latest }

    // ---- JeV event kinds ----
    const JEV_PLUGIN_PREFIX = 'plugin:jev-harness/'
    function jevKindOf(type) {
      if (typeof type !== 'string') return null
      if (type === 'jev/decision' || type === JEV_PLUGIN_PREFIX + 'decision') return 'decision'
      if (type === 'jev/gate' || type === JEV_PLUGIN_PREFIX + 'gate') return 'gate'
      if (type === 'jev/receipt' || type === JEV_PLUGIN_PREFIX + 'receipt') return 'receipt'
      return null
    }

    // ---- cross-turn ledger, STRICTLY per session ----
    const ledgerBySession = new Map()
    const maxTurnBySession = new Map()
    const seenBySession = new Map()
    let turnLedger = new Map()
    let maxTurnSeen = 0
    let seenJev = new Set()
    function ensureSession(sid) {
      if (!ledgerBySession.has(sid)) ledgerBySession.set(sid, new Map())
      if (!seenBySession.has(sid)) seenBySession.set(sid, new Set())
      return sid
    }
    function activateSession(sid) {
      ensureSession(sid)
      turnLedger = ledgerBySession.get(sid)
      seenJev = seenBySession.get(sid)
      maxTurnSeen = maxTurnBySession.get(sid) || 0
      return turnLedger
    }
    function noteTurn(ev) {
      const t = ev && ev.data && ev.data.turn
      if (typeof t !== 'number' || !isFinite(t) || t <= maxTurnSeen) return
      maxTurnSeen = t
      const sid = (ev && ev.data && ev.data.sessionId) || activeSessionId
      if (typeof sid === 'string' && sid) maxTurnBySession.set(sid, t)
    }
    function turnRow(n) {
      const key = typeof n === 'number' ? n : 0
      let r = turnLedger.get(key)
      if (!r) {
        r = { turn: key, decisions: 0, gates: 0, denies: 0, savedTokens: 0, ledgerChars: 0, cacheReuse: 0 }
        turnLedger.set(key, r)
      }
      return r
    }
    function recordJevEvent(ev) {
      try {
        const d = (ev && ev.data) || {}
        const sid = typeof d.sessionId === 'string' && d.sessionId ? d.sessionId : (activeSessionId || '∅')
        ensureSession(sid)
        if (turnLedger !== ledgerBySession.get(sid)) {
          turnLedger = ledgerBySession.get(sid)
          seenJev = seenBySession.get(sid)
          if (!maxTurnSeen && maxTurnBySession.has(sid)) maxTurnSeen = maxTurnBySession.get(sid)
        }
        const seen = seenBySession.get(sid)
        const key = sid + '|' + (ev && ev.seq) + '|' + (ev && ev.type)
        if (seen.has(key)) return
        seen.add(key)
        const r = turnRow(typeof d.turn === 'number' ? d.turn : 0)
        if (jevKindOf(ev && ev.type) === 'decision') {
          r.decisions += 1
          r.savedTokens += typeof d.savedTokens === 'number' ? d.savedTokens : 0
          r.ledgerChars += typeof d.ledgerChars === 'number' ? d.ledgerChars : 0
          if (d.cacheFrozen) r.cacheReuse += 1
        } else if (jevKindOf(ev && ev.type) === 'gate') {
          r.gates += 1
          if (d.verdict === 'deny') r.denies += 1
        }
      } catch (e) { /* ledger is fail-open */ }
    }
    function savingRate(tokens, chars) {
      const budget = (typeof chars === 'number' ? chars : 0) / 4
      return budget > 0 ? Math.max(0, Math.min(100, Math.round(((typeof tokens === 'number' ? tokens : 0) / budget) * 100))) : 0
    }
    function turnRows() {
      return Array.from(turnLedger.values()).sort((a, b) => a.turn - b.turn)
        .map((r) => Object.assign({}, r, { rate: savingRate(r.savedTokens, r.ledgerChars) }))
    }
    function ledgerTotals() {
      const rows = turnRows()
      const t = rows.reduce((a, r) => ({
        decisions: a.decisions + r.decisions,
        gates: a.gates + r.gates,
        denies: a.denies + r.denies,
        savedTokens: a.savedTokens + r.savedTokens,
        ledgerChars: a.ledgerChars + r.ledgerChars,
        cacheReuse: a.cacheReuse + r.cacheReuse,
      }), { decisions: 0, gates: 0, denies: 0, savedTokens: 0, ledgerChars: 0, cacheReuse: 0 })
      t.rounds = Math.max(rows.length, maxTurnSeen)
      t.rate = savingRate(t.savedTokens, t.ledgerChars)
      return t
    }
    function enrichState(s) {
      return s ? Object.assign({}, s, { turns: turnRows(), totals: ledgerTotals() }) : s
    }

    // ---- session-scoped gating: the single HUD slot ----
    function sessionIdOf(props) {
      const p = props || {}
      if (typeof p.sessionId === 'string' && p.sessionId) return p.sessionId
      if (p.session && typeof p.session.id === 'string') return p.session.id
      const binding = p.currentSession || (clientCtx && clientCtx.currentSession)
      if (binding && typeof binding.getSnapshot === 'function') {
        const snap = binding.getSnapshot()
        if (snap && typeof snap.key === 'string' && snap.key) return snap.key
      }
      return null
    }
    function blankSession(id) {
      try {
        const sessions = clientCtx && clientCtx.sessions
        if (!id || !sessions) return false
        const list = sessions.list && typeof sessions.list.getSnapshot === 'function' ? sessions.list.getSnapshot() : null
        const row = list && list.byId && list.byId[id]
        if (row && row.blank === true) return true
        if (typeof sessions.scope === 'function') {
          const scoped = sessions.scope(id)
          const snap = scoped && scoped.session && typeof scoped.session.getSnapshot === 'function' ? scoped.session.getSnapshot() : null
          if (snap && snap.blank === true) return true
        }
      } catch (e) { /* fail-open */ }
      return false
    }
    function hasJevState() {
      const s = hud.latest
      return !!(s && ((s.decisions && s.decisions.length) || (s.gates && s.gates.length)))
    }
    function jevVisible(props) {
      const id = sessionIdOf(props)
      if (!id) return true
      if (blankSession(id)) return false
      if (activeSessionId && activeSessionId !== id) return false
      return true
    }
    function noteSession(ev) {
      const sid = ev && ev.data && ev.data.sessionId
      const switched = typeof sid === 'string' && sid !== activeSessionId
      if (switched) {
        activeSessionId = sid
        activateSession(sid)
        hud.latest = null
        settled.snap = null
        settled.mode = false
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        for (const fn of hud.listeners) { try { fn() } catch (e) { /* ignore */ } }
        for (const fn of settled.listeners) { try { fn() } catch (e) { /* ignore */ } }
      }
      noteTurn(ev)
      return switched
    }

    // ---- state fold ----
    function initState(ev) {
      const turn = ev.data && typeof ev.data.turn === 'number' ? ev.data.turn : 0
      return { turn: turn, decisions: jevKindOf(ev.type) === 'decision' ? [ev.data] : [], gates: jevKindOf(ev.type) === 'gate' ? [ev.data] : [] }
    }
    function foldState(state, ev) {
      const s = state || { turn: 0, decisions: [], gates: [] }
      const turn = ev.data && typeof ev.data.turn === 'number' ? ev.data.turn : s.turn
      if (jevKindOf(ev.type) === 'decision') {
        const step = ev.data && ev.data.step
        const keyOf = function (d) { return (d && typeof d.turn === 'number' ? d.turn : 'x') + ':' + (d && d.step) }
        const decisions = s.decisions.filter(function (d) { return step === undefined || keyOf(d) !== keyOf(ev.data) }).concat([ev.data])
        return { turn: turn, decisions: decisions, gates: s.gates }
      }
      return { turn: turn, decisions: s.decisions, gates: s.gates.concat([ev.data]) }
    }

    const definition = {
      kind: KIND,
      target: 'chat',
      match: function (event) {
        if (event && (jevKindOf(event.type) === 'decision' || jevKindOf(event.type) === 'gate')) {
          const turn = event.data && typeof event.data.turn === 'number' ? event.data.turn : 0
          return { id: 't' + turn, role: 'start' }
        }
        return null
      },
      start: function (_context, match) { noteSession(match.event); recordJevEvent(match.event); const s = initState(match.event); hudSet(s); return s },
      update: function (context, match) { const reset = noteSession(match.event); recordJevEvent(match.event); const s = reset ? initState(match.event) : foldState(context && context.state, match.event); hudSet(s); return s },
      publication: function () { return 'immediate' },
      // State only. No inline card; the header HUD is the sole visible anchor.
      buildViewNode: function () { return null },
    }

    // Turn-end definition still snapshots the receipt into the settled store.
    const RECEIPT_KIND = KIND + '-receipt'
    const receiptDefinition = {
      kind: RECEIPT_KIND,
      target: 'chat',
      match: function (event) {
        if (event && (event.type === 'turn/end' || jevKindOf(event.type) === 'receipt')) {
          if (!hasJevState()) return null
          const d = event.data || {}
          const turn = typeof d.turn === 'number' ? d.turn : (typeof event.turn === 'number' ? event.turn : 0)
          return { id: 'r' + turn, role: 'start' }
        }
        return null
      },
      start: function (match) { noteSession(match && match.event); recordJevEvent(match && match.event); const s = enrichState(Object.assign({}, hud.latest || { turn: 0, decisions: [], gates: [] })); s.endedAt = Date.now(); settleNow(s); return s },
      update: function (context, match) {
        noteSession(match && match.event)
        recordJevEvent(match && match.event)
        const s = enrichState(Object.assign({}, hud.latest || (context && context.state) || { turn: 0, decisions: [], gates: [] }))
        s.turn = match && match.event && match.event.data && typeof match.event.data.turn === 'number' ? match.event.data.turn : s.turn
        s.endedAt = Date.now()
        settleNow(s)
        return s
      },
      publication: function () { return 'immediate' },
      buildViewNode: function () { return null },
    }

    function fmtTok(n) {
      const v = typeof n === 'number' && isFinite(n) ? n : 0
      const a = Math.abs(v)
      if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B'
      if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M'
      if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'
      return String(v)
    }

    function JevGauge(props) {
      const reuse = Math.max(0, Math.min(100, props.reuse || 0))
      const r = 44
      const c = 2 * Math.PI * r
      const dash = (reuse / 100) * c
      return h('div', { className: 'jev-gauge-box' },
        h('svg', { viewBox: '0 0 120 120', width: 124, height: 124, role: 'img', 'aria-label': 'KV 复用率仪表' },
          h('circle', { cx: 60, cy: 60, r: r + 8, fill: 'none', stroke: 'rgba(214,247,90,.14)', strokeWidth: 1, strokeDasharray: '2 4' }),
          h('circle', { cx: 60, cy: 60, r: r, fill: 'none', stroke: 'rgba(214,247,90,.18)', strokeWidth: 8 }),
          h('circle', { cx: 60, cy: 60, r: r, fill: 'none', stroke: '#d6f75a', strokeWidth: 8, strokeDasharray: dash + ' ' + c, transform: 'rotate(-90 60 60)' }),
          h('g', { transform: 'rotate(' + (-120 + reuse * 2.4) + ' 60 60)' },
            h('line', { x1: 60, y1: 60, x2: 60, y2: 20, stroke: '#ffb000', strokeWidth: 2 }),
            h('circle', { cx: 60, cy: 60, r: 4, fill: '#ffb000' })),
          h('text', { x: 60, y: 66, textAnchor: 'middle', fill: '#d6f75a', fontSize: 18, fontWeight: 800 }, reuse + '%'),
          h('text', { x: 60, y: 82, textAnchor: 'middle', fill: '#7f906f', fontSize: 9 }, 'KV REUSE')))
    }

    function JevChart(props) {
      const rows = props.rows || []
      const w = 260
      const hg = 78
      const vals = rows.length ? rows.map((r) => r.rate) : [0]
      const max = Math.max.apply(null, [10].concat(vals))
      const xOf = function (i) { return vals.length === 1 ? w : (i / (vals.length - 1)) * w }
      const yOf = function (v) { return hg - (v / max) * (hg - 12) }
      const pts = vals.map((v, i) => xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1)).join(' ')
      const area = '0,' + hg + ' ' + pts + ' ' + w + ',' + hg
      return h('div', { className: 'jev-chart-box' },
        h('div', { className: 'jev-box-label' }, 'SAVINGS / TURN'),
        h('svg', { viewBox: '0 0 ' + w + ' ' + hg, width: '100%', height: 74, preserveAspectRatio: 'none', role: 'img', 'aria-label': '每轮节省比例曲线' },
          h('line', { x1: 0, y1: hg - 8, x2: w, y2: hg - 8, stroke: 'rgba(214,247,90,.2)', strokeWidth: 1 }),
          h('polygon', { points: area, fill: 'rgba(214,247,90,.12)' }),
          h('polyline', { points: pts, fill: 'none', stroke: '#d6f75a', strokeWidth: 2 }),
          rows.map((r, i) => h('circle', { key: 'c' + i, cx: xOf(i), cy: yOf(r.rate), r: 2.5, fill: '#ffb000' }))))
    }

    function JevReceiptPopover(props) {
      React.useEffect(() => { ensureStyles() }, [])
      const s = props.state || {}
      const rounds = s.turns || turnRows()
      const tot = s.totals || ledgerTotals()
      const decs = s.decisions || []
      const gates = s.gates || []
      const denies = gates.filter((g) => g.verdict === 'deny')
      const last = decs.length ? decs[decs.length - 1] : null
      const lat = last && typeof last.latencyMs === 'number' ? Math.round(last.latencyMs) : null
      const reuse = tot.decisions ? Math.round((tot.cacheReuse / tot.decisions) * 100) : 0
      const step = last && typeof last.step === 'number' ? last.step : 0
      const tiles = [
        ['STEP / 决策', String(step || tot.decisions), ''],
        ['HEALTH / 状态', denies.length ? 'DENY' : 'OK', denies.length ? 'red' : ''],
        ['IMAGE / 版本', 'jev 2.3.3', ''],
        ['REPL / 拦截', String(denies.length), denies.length ? 'amber' : ''],
        ['BUDGET / 节省', tot.rate + '%', 'amber'],
        ['TIMEOUT / 延迟', lat === null ? 'n/a' : lat + 'ms', ''],
      ]
      function receiptText() {
        return 'JEV 治理回执 · ' + tot.rounds + ' 轮 · 决策 ' + tot.decisions + ' · 拦截 ' + tot.gates +
          ' · KV 复用 ' + reuse + '% · 省约 ' + fmtTok(tot.savedTokens) + ' tokens (' + tot.rate + '%)'
      }
      function copyReceipt() {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') navigator.clipboard.writeText(receiptText())
        } catch (e) { /* clipboard is best-effort */ }
      }
      return h('div', { id: 'jev-receipt-pop', className: 'jev-pop', style: { left: props.left, top: props.top }, role: 'dialog', 'aria-label': 'JEV 治理回执' },
        h('div', { className: 'jev-pop-head' },
          h('span', { className: 'jev-pop-title' }, 'JEV // RECEIPT'),
          h('span', { className: 'jev-barcode' }),
          h('span', { className: 'jev-live' }, 'LIVE'),
          h('button', { type: 'button', className: 'jev-btn ghost', onClick: props.onClose, 'aria-label': '关闭回执' }, '×')),
        h('div', { className: 'jev-pop-body' },
          h('div', { className: 'jev-tiles' }, tiles.map((t) => h('div', { className: 'jev-tile', key: t[0] },
            h('span', { className: 'jev-tile-label' }, t[0]),
            h('span', { className: 'jev-tile-value' + (t[2] ? ' ' + t[2] : '') }, t[1])))),
          h('div', { className: 'jev-instrument' },
            h(JevGauge, { reuse: reuse }),
            h(JevChart, { rows: rounds })),
          denies.length
            ? h('div', { className: 'jev-alert' },
                h('div', { className: 'jev-alert-title' }, 'POLICY · DENIED'),
                h('div', null, denies.length + ' 次拦截 · 规则 ' + (denies[0].ruleId || 'policy')),
                denies[0].reason ? h('div', null, String(denies[0].reason).slice(0, 120)) : null)
            : h('div', { className: 'jev-alert ok' },
                h('div', { className: 'jev-alert-title' }, 'ALL CLEAR · 无拦截'),
                h('div', null, '本会话没有策略拦截')),
          h('div', { className: 'jev-stream' }, rounds.length
            ? rounds.map((r) => h('div', { className: 'jev-stream-row', key: 'row' + r.turn },
                h('span', null, 'T+' + String(r.turn).padStart(2, '0')),
                h('b', null, '决策 ' + r.decisions),
                h('span', { className: 'amber' }, '拦截 ' + r.gates),
                h('span', null, '省 ' + fmtTok(r.savedTokens)),
                h('span', null, r.rate + '%')))
            : h('div', { className: 'jev-stream-row' }, '等待会话事件…')),
          h('div', { className: 'jev-foot' },
            h('div', null,
              h('span', { className: 'jev-metric' }, 'KV 复用 ' + reuse + '%'),
              h('span', { className: 'jev-metric' }, '省约 ' + fmtTok(tot.savedTokens) + ' tokens · ' + tot.rate + '%'),
              h('span', { className: 'jev-metric' }, '决策 ' + tot.decisions + ' · 拦截 ' + tot.gates)),
            h('div', null,
              h('button', { type: 'button', className: 'jev-btn ghost', onClick: copyReceipt }, '复制回执'),
              h('button', { type: 'button', className: 'jev-btn', onClick: props.onClose }, '关闭')),
            h('div', { className: 'jev-foot-note' }, 'HOLD ' + reuse + '% · 全会话 ' + tot.rounds + ' 轮 · 省约 ' + fmtTok(tot.savedTokens) + ' tokens (' + tot.rate + '%) THEN → ', h('em', null, 'JEV HARNESS AUTO')))))
    }

    // Floating receipt is mounted on document.body, not inside the header.
    // Header utilities may clip or transform fixed children; body mounting cannot.
    function escHtml(v) {
      return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    }
    function receiptMarkup(s) {
      const rounds = (s && s.turns) || turnRows()
      const tot = (s && s.totals) || ledgerTotals()
      const decs = (s && s.decisions) || []
      const gates = (s && s.gates) || []
      const denies = gates.filter(function (g) { return g.verdict === "deny" })
      const last = decs.length ? decs[decs.length - 1] : null
      const lat = last && typeof last.latencyMs === "number" ? Math.round(last.latencyMs) : null
      const reuse = tot.decisions ? Math.round((tot.cacheReuse / tot.decisions) * 100) : 0
      const dash = ((reuse / 100) * 2 * Math.PI * 44).toFixed(1)
      const vals = rounds.length ? rounds.map(function (r) { return r.rate }) : [0]
      const max = Math.max.apply(null, [10].concat(vals))
      const xOf = function (i) { return vals.length === 1 ? 260 : (i / (vals.length - 1)) * 260 }
      const yOf = function (v) { return 78 - (v / max) * 66 }
      const pts = vals.map(function (v, i) { return xOf(i).toFixed(1) + "," + yOf(v).toFixed(1) }).join(" ")
      const summary = "JEV 治理回执 · " + tot.rounds + " 轮 · 决策 " + tot.decisions + " · 拦截 " + tot.gates + " · KV 复用 " + reuse + "% · 省约 " + fmtTok(tot.savedTokens) + " tokens (" + tot.rate + "%)"
      const tiles = [
        ["STEP / 决策", String((last && last.step) || tot.decisions), ""],
        ["HEALTH / 状态", denies.length ? "DENY" : "OK", denies.length ? "red" : ""],
        ["IMAGE / 版本", "jev 2.3.5", ""],
        ["REPL / 拦截", String(denies.length), denies.length ? "amber" : ""],
        ["BUDGET / 节省", tot.rate + "%", "amber"],
        ["TIMEOUT / 延迟", lat === null ? "n/a" : lat + "ms", ""],
      ]
      let html = ""
      html += "<div class=\"jev-pop-head\"><span class=\"jev-pop-title\">JEV // RECEIPT</span><span class=\"jev-barcode\"></span><span class=\"jev-live\">LIVE</span><button type=\"button\" class=\"jev-btn ghost\" data-jev-close=\"1\">×</button></div>"
      html += "<div class=\"jev-pop-body\">"
      html += "<div class=\"jev-tiles\">" + tiles.map(function (t) { return "<div class=\"jev-tile\"><span class=\"jev-tile-label\">" + escHtml(t[0]) + "</span><span class=\"jev-tile-value " + t[2] + "\">" + escHtml(t[1]) + "</span></div>" }).join("") + "</div>"
      html += "<div class=\"jev-instrument\"><div class=\"jev-gauge-box\"><svg viewBox=\"0 0 120 120\" width=\"124\" height=\"124\"><circle cx=\"60\" cy=\"60\" r=\"52\" fill=\"none\" stroke=\"rgba(214,247,90,.14)\" stroke-width=\"1\" stroke-dasharray=\"2 4\"/><circle cx=\"60\" cy=\"60\" r=\"44\" fill=\"none\" stroke=\"rgba(214,247,90,.18)\" stroke-width=\"8\"/><circle cx=\"60\" cy=\"60\" r=\"44\" fill=\"none\" stroke=\"#d6f75a\" stroke-width=\"8\" stroke-dasharray=\"" + dash + " 276.5\" transform=\"rotate(-90 60 60)\"/><text x=\"60\" y=\"66\" text-anchor=\"middle\" fill=\"#d6f75a\" font-size=\"18\" font-weight=\"800\">" + reuse + "%</text><text x=\"60\" y=\"82\" text-anchor=\"middle\" fill=\"#7f906f\" font-size=\"9\">KV REUSE</text></svg></div>"
      html += "<div class=\"jev-chart-box\"><div class=\"jev-box-label\">SAVINGS / TURN</div><svg viewBox=\"0 0 260 78\" width=\"100%\" height=\"74\" preserveAspectRatio=\"none\"><polygon points=\"0,78 " + pts + " 260,78\" fill=\"rgba(214,247,90,.12)\"/><polyline points=\"" + pts + "\" fill=\"none\" stroke=\"#d6f75a\" stroke-width=\"2\"/>" + rounds.map(function (r, i) { return "<circle cx=\"" + xOf(i).toFixed(1) + "\" cy=\"" + yOf(r.rate).toFixed(1) + "\" r=\"2.5\" fill=\"#ffb000\"/>" }).join("") + "</svg></div></div>"
      html += denies.length
        ? "<div class=\"jev-alert\"><div class=\"jev-alert-title\">POLICY · DENIED</div><div>" + denies.length + " 次拦截 · 规则 " + escHtml(denies[0].ruleId || "policy") + "</div>" + (denies[0].reason ? "<div>" + escHtml(String(denies[0].reason).slice(0, 120)) + "</div>" : "") + "</div>"
        : "<div class=\"jev-alert ok\"><div class=\"jev-alert-title\">ALL CLEAR · 无拦截</div><div>本会话没有策略拦截</div></div>"
      html += "<div class=\"jev-stream\">" + (rounds.length ? rounds.map(function (r) { return "<div class=\"jev-stream-row\"><span>T+" + String(r.turn).padStart(2, "0") + "</span><b>决策 " + r.decisions + "</b><span class=\"amber\">拦截 " + r.gates + "</span><span>省 " + fmtTok(r.savedTokens) + "</span><span>" + r.rate + "%</span></div>" }).join("") : "<div class=\"jev-stream-row\">等待会话事件…</div>") + "</div>"
      html += "<div class=\"jev-foot\"><div><span class=\"jev-metric\">KV 复用 " + reuse + "%</span><span class=\"jev-metric\">省约 " + fmtTok(tot.savedTokens) + " tokens · " + tot.rate + "%</span><span class=\"jev-metric\">决策 " + tot.decisions + " · 拦截 " + tot.gates + "</span></div><div><button type=\"button\" class=\"jev-btn ghost\" data-jev-copy=\"1\">复制回执</button> <button type=\"button\" class=\"jev-btn\" data-jev-close=\"1\">关闭</button></div><div class=\"jev-foot-note\">HOLD " + reuse + "% · 全会话 " + tot.rounds + " 轮 · 省约 " + fmtTok(tot.savedTokens) + " tokens (" + tot.rate + "%) THEN → <em>JEV HARNESS AUTO</em></div></div>"
      html += "</div>"
      return { html: html, copy: summary }
    }
    function unmountReceipt() {
      if (typeof document === "undefined") return
      const old = document.getElementById("jev-receipt-pop")
      if (old && old.parentNode) old.parentNode.removeChild(old)
      try { window.__JEV_POPUP_OPEN__ = false } catch (e) { /* ignore */ }
    }
    function mountReceipt(s, left, top, onClose) {
      unmountReceipt()
      if (typeof document === "undefined" || !document.body) return
      ensureStyles()
      const data = receiptMarkup(s)
      const box = document.createElement("div")
      box.id = "jev-receipt-pop"
      box.className = "jev-pop"
      box.setAttribute("role", "dialog")
      box.setAttribute("aria-label", "JEV 治理回执")
      box.setAttribute("data-copy", data.copy)
      box.style.left = Math.round(left) + "px"
      box.style.top = Math.round(top) + "px"
      box.innerHTML = data.html
      const closes = box.querySelectorAll("[data-jev-close]")
      for (let i = 0; i < closes.length; i++) closes[i].addEventListener("click", function (ev) { ev.stopPropagation(); onClose() })
      const copy = box.querySelector("[data-jev-copy]")
      if (copy) copy.addEventListener("click", function (ev) {
        ev.stopPropagation()
        try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(box.getAttribute("data-copy") || "") } catch (e) { /* ignore */ }
      })
      document.body.appendChild(box)
      try { window.__JEV_POPUP_OPEN__ = true } catch (e) { /* ignore */ }
    }
    function JevHud(props) {
      React.useEffect(() => { ensureStyles() }, [])
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState({ left: 24, top: 44 })
      const btnRef = React.useRef(null)
      const s = useHud()
      const st = useSettled()
      React.useEffect(() => {
        if (!open) { unmountReceipt(); return undefined }
        mountReceipt(st.mode && st.snap ? st.snap : s, anchor.left, anchor.top, function () { setOpen(false) })
        function outside(e) {
          const t = e.target
          if (btnRef.current && btnRef.current.contains(t)) return
          const pop = typeof document !== 'undefined' ? document.getElementById('jev-receipt-pop') : null
          if (pop && pop.contains(t)) return
          setOpen(false)
        }
        function esc(e) { if (e.key === 'Escape') { setOpen(false); unmountReceipt() } }
        if (typeof document !== 'undefined') {
          document.addEventListener('mousedown', outside)
          document.addEventListener('keydown', esc)
        }
        return function () {
          if (typeof document !== 'undefined') {
            document.removeEventListener('mousedown', outside)
            document.removeEventListener('keydown', esc)
          }
        }
      }, [open, s, st, anchor])
      if (!jevVisible(props)) return null
      const last = s && s.decisions && s.decisions.length ? s.decisions[s.decisions.length - 1] : null
      const step = last && typeof last.step === 'number' ? last.step : null
      const lat = last && typeof last.latencyMs === 'number' ? Math.round(last.latencyMs) : null
      const denies = s && s.gates ? s.gates.filter((g) => g.verdict === 'deny').length : 0
      function toggle() {
        if (!open && btnRef.current && typeof btnRef.current.getBoundingClientRect === 'function') {
          const r = btnRef.current.getBoundingClientRect()
          const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
          const vh = typeof window !== 'undefined' ? window.innerHeight : 800
          setAnchor({ left: Math.max(12, Math.min(r.left, vw - 432)), top: Math.min(r.bottom + 8, Math.max(12, vh - 140)) })
        }
        setOpen(function (v) { if (v) unmountReceipt(); return !v })
      }
      const snap = st.mode && st.snap ? st.snap : s
      return h('span', { className: 'jev-hud-wrap' },
        h('button', { type: 'button', ref: btnRef, className: 'jev-hud', onClick: toggle, title: '点击查看 JEV 治理回执 · v2.3.4', 'aria-expanded': open },
          h('span', { className: 'jev-dot' }),
          h('span', null, 'JEV v2.3.5'),
          step !== null ? h('span', { className: 'jev-sep' }, '·') : null,
          step !== null ? h('span', null, 'Step #' + step) : null,
          lat !== null ? h('span', { className: 'jev-sep' }, '·') : null,
          lat !== null ? h('span', null, lat + 'ms') : null,
          denies > 0 ? h('span', { className: 'jev-badge-deny' }, ' ⛊ ' + denies) : null),
        null) /* receipt mounted on document.body */
    }

    return {
      inject: ['uiConversation', 'slots'],
      apply(ctx) {
        clientCtx = ctx || null
        try { if (typeof window !== 'undefined') window.__JEV_CLIENT_LOADED__ = true } catch (e) { /* ignore */ }
        try { ensureStyles() } catch (e) { /* ignore */ }
        log('apply, uiConversation=', !!(ctx && ctx.uiConversation), 'slots=', !!(ctx && ctx.slots))
        try { ctx.uiConversation.events.register(definition); log('node definition registered') } catch (e) { log('node definition FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.uiConversation.events.register(receiptDefinition); log('receipt definition registered') } catch (e) { log('receipt definition FAILED', String(e && e.message ? e.message : e)) }
        try { ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'jev-harness-hud', order: 40 }, JevHud)); log('hud slot registered') } catch (e) { log('hud slot FAILED', String(e && e.message ? e.message : e)) }
      },
    }
  },
})
