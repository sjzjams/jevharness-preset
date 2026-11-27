import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const loop = readFileSync(join(root, 'jev-harness-loop', 'index.mjs'), 'utf8')

function has(src, s) { assert.ok(src.includes(s), 'missing: ' + s) }
function hasNot(src, s) { assert.ok(!src.includes(s), 'must not contain: ' + s) }
function countOf(src, s) { return src.split(s).length - 1 }

test('ui: only the header HUD slot is registered', () => {
  has(client, "inject: ['uiConversation', 'slots']")
  has(client, "name: 'conversation.session.header.utilities', id: 'jev-harness-hud', order: 40")
  has(client, "function JevHud(props)")
  for (const s of [
    'conversation.input.dock',
    'conversation.input.left',
    "name: 'conversation.chat.node'",
    'sidebarRightTabs',
    'sidebar.right.pane.tab',
    'function JevPill(',
    'function JevLiveDock(',
    'function JevReceiptView(',
    'function JevDeepPanel(',
  ]) hasNot(client, s)
})

test('ui: bundle no longer injects the sidebar-right client package', () => {
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'))
  assert.ok(!pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
})

test('ui: state folds decisions and gates but anchors no inline card', () => {
  has(client, "jevKindOf(event.type) === 'decision' || jevKindOf(event.type) === 'gate'")
  has(client, 'function foldState(state, ev)')
  assert.ok(countOf(client, 'buildViewNode: function () { return null }') >= 2, 'both Definitions must stay state-only')
  has(client, "RECEIPT_KIND = KIND + '-receipt'")
  has(client, "event.type === 'turn/end'")
  has(client, "jevKindOf(event.type) === 'receipt'")
})

test('ui: clicking the HUD opens a floating receipt window', () => {
  has(client, 'React.useState(false)')
  has(client, "id: 'jev-receipt-pop', className: 'jev-pop'")
  has(client, "className: 'jev-hud', onClick: toggle")
  has(client, 'mountReceipt(st.mode && st.snap ? st.snap : s, anchor.left, anchor.top')
  has(client, 'getBoundingClientRect')
  has(client, "document.addEventListener('mousedown', outside)")
  has(client, "document.addEventListener('keydown', esc)")
  has(client, "e.key === 'Escape'")
  has(client, "'aria-expanded': open")
  has(client, 'v2.3.5')
})

test('ui: floating receipt mounts on document.body to avoid header clipping', () => {
  has(client, 'document.body.appendChild(box)')
  has(client, "const old = document.getElementById(\"jev-receipt-pop\")")
  has(client, 'function unmountReceipt()')
  has(client, 'function mountReceipt(s, left, top, onClose)')
  has(client, 'window.__JEV_POPUP_OPEN__ = true')
})

test('ui: floating receipt follows the dark terminal reference style', () => {
  for (const s of [
    '#090c0a',
    '#d6f75a',
    '#ffb000',
    '#ff5a4d',
    'jev-barcode',
    'repeating-linear-gradient(0deg,rgba(214,247,90,.028)',
    'clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px',
    'position:fixed;width:420px',
    "h('span', { className: 'jev-live' }, 'LIVE')",
    'h(JevGauge, { reuse: reuse })',
    'h(JevChart, { rows: rounds })',
    "'JEV // RECEIPT'",
    "'POLICY · DENIED'",
    "'ALL CLEAR · 无拦截'",
    "'复制回执'",
  ]) has(client, s)
})

test('ui: fmtTok has no temporal-dead-zone read', () => {
  has(client, "const v = typeof n === 'number' && isFinite(n) ? n : 0")
  hasNot(client, 'isFinite(v) ? v : 0')
})

test('ui: receipt gauge and chart use real ledger values', () => {
  has(client, 'function JevGauge(props)')
  has(client, 'function JevChart(props)')
  has(client, 'const reuse = tot.decisions ? Math.round((tot.cacheReuse / tot.decisions) * 100) : 0')
  has(client, 'const pts = vals.map')
  has(client, "rows.map((r, i) => h('circle'")
  has(client, "'T+' + String(r.turn).padStart(2, '0')")
})

test('ui: receipt shows all-turn rollup and totals with savings ratio', () => {
  for (const s of [
    "'省约 ' + fmtTok(tot.savedTokens) + ' tokens · ' + tot.rate + '%'",
    "'决策 ' + tot.decisions + ' · 拦截 ' + tot.gates",
    "'KV 复用 ' + reuse + '%'",
    "'省 ' + fmtTok(r.savedTokens)",
    "'% · 全会话 ' + tot.rounds + ' 轮 · 省约 '",
  ]) has(client, s)
})

test('ui: receipt snapshot survives an idle debounce without host turn/end', () => {
  has(client, 'function settleNow(s)')
  has(client, 'function touchActivity(s)')
  has(client, 'setTimeout(() => { settleNow(hud.latest)')
  has(client, '4000')
  has(client, 'function useSettled()')
  has(client, 'st.mode && st.snap ? st.snap : s')
})

test('ui: the lone HUD slot stays hidden outside a started JEV session', () => {
  has(client, 'function jevVisible(props)')
  has(client, 'function blankSession(id)')
  has(client, 'function hasJevState()')
  has(client, 'function noteSession(ev)')
  has(client, 'if (!jevVisible(props)) return null')
  has(client, 'if (!id) return true')
  has(client, "h('span', null, 'JEV v2.3.5')")
})

test('host: turn/end emits a jev/receipt fallback event', () => {
  has(loop, "type === 'turn/end'")
  has(loop, "appendJev(session, 'jev/receipt'")
  has(loop, "kind: 'turn/end'")
})

test('phase3: host projects ladder + rule hits on both event channels', () => {
  has(loop, 'chunkLadder = chunkStore.listMetadata')
  has(loop, 'ruleHits = Array.isArray(condResult?.rules)')
  assert.ok(countOf(loop, 'chunkLadder,\n') >= 2, 'chunkLadder must be in liveBus and appendJev payloads')
  assert.ok(countOf(loop, 'ruleHits,\n') >= 2, 'ruleHits must be in liveBus and appendJev payloads')
})

test('host: jev events are persisted as host plugin records (log stays loadable)', () => {
  has(loop, 'const sid = session && (session.id || session.sessionId)')
  has(loop, 'Object.assign({}, data, { sessionId: sid })')
  has(loop, 'appendPluginRecord(session, pluginType, payload)')
  has(loop, "'plugin:jev-harness/'")
  has(loop, 'function toPluginRecordType(type)')
})

test('ui: card ledger is per-session and idempotent (no turn-1 inflation)', () => {
  has(client, 'const ledgerBySession = new Map()')
  has(client, 'const seenBySession = new Map()')
  has(client, 'seen.has(key)')
  has(client, 'activateSession(sid)')
})
