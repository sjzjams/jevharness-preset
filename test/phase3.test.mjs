import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(root, 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const loop = readFileSync(join(root, 'jev-harness-loop', 'index.mjs'), 'utf8')

test('phase3: client registers a dedicated right-sidebar JEV tab', () => {
  assert.match(client, /sidebarRightTabs\.register\(/)
  assert.match(client, /name: 'sidebar\.right\.pane\.tab'/)
  assert.match(client, /SIDEBAR_ID = '@local\/dsh-jevharness-preset\/sidebar'/)
  assert.match(client, /SIDEBAR_KIND = 'jev-harness-decisions'/)
  assert.match(client, /clientCtx\.sidebarRight\.openTab\(SIDEBAR_KIND\)/)
  assert.match(client, /inject: \['uiConversation', 'slots', 'sidebarRight', 'sidebarRightTabs'\]/)
})

test('phase3: client renders chunk ladder and conditional-rule hits', () => {
  assert.match(client, /jev-ladder-seg/)
  assert.match(client, /'hide'.*'short_summary'.*'long_summary'.*'full'/s)
  assert.match(client, /chunkLadder/)
  assert.match(client, /ruleHits/)
  assert.match(client, /jev-rule-reason/)
  assert.match(client, /本回合没有命中条件规则/)
})

test('ui: deep console shares card style and explains every field in Chinese', () => {
  assert.match(client, /className: 'jev-card jev-deep-card'/)
  assert.match(client, /function valueLabel\(v\)/)
  assert.match(client, /const DIMENSIONS = \[/)
  assert.match(client, /六步决策 · 逐项说明/)
  assert.match(client, /每份资料给模型看多少/)
  assert.match(client, /不送进模型，最省 token/)
  assert.doesNotMatch(client, /className: 'jev-deep'/)
})

test('ui: deep console uses tone-step layout and rule-hit examples', () => {
  assert.match(client, /\.jev-deep-sec\{margin-top:10px;padding:10px 12px/)
  assert.doesNotMatch(client, /\.jev-deep-title\{[^}]*border-top/)
  assert.match(client, /function ruleExample\(r\)/)
  assert.match(client, /paths:\(\[\^;\]\+\)/)
  assert.match(client, /keywords:\(\[\^;\]\+\)/)
  assert.match(client, /className: 'jev-rule-example'/)
  assert.match(client, /例如：读到 /)
})

test('ui: deep console embeds the JEV data flow diagram', () => {
  assert.match(client, /const flowSec = h\('div', \{ className: 'jev-flow'/)
  assert.match(client, /viewBox: '0 0 600 96'/)
  assert.match(client, /jevFlowArrow/)
  assert.match(client, /flowNodes/)
  assert.match(client, /ladderSec, flowSec, ruleSec/)
})

test('phase3: host projects ladder + rule hits on both event channels', () => {
  assert.match(loop, /chunkLadder = chunkStore\.listMetadata/)
  assert.match(loop, /ruleHits = Array\.isArray\(condResult\?\.rules\)/)
  const ladderFields = (loop.match(/\bchunkLadder,\n/g) || []).length
  const ruleFields = (loop.match(/\bruleHits,\n/g) || []).length
  assert.ok(ladderFields >= 2, 'chunkLadder must be in liveBus and appendJev payloads')
  assert.ok(ruleFields >= 2, 'ruleHits must be in liveBus and appendJev payloads')
})

test('phase3: bundle injects the sidebar-right client package', () => {
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
})

test('ui: live intervention docks at the conversation bottom, never at top', () => {
  assert.match(client, /name: 'conversation\.input\.dock'/)
  assert.match(client, /id: 'jev-harness-live-dock'/)
  assert.match(client, /function JevLiveDock\(/)
  assert.match(client, /jev-dock-sticky/)
  assert.match(client, /buildViewNode: function \(\) \{ return null \}/)
  assert.doesNotMatch(client, /key: KIND \}, JevNodeView/)
})

test('ui: turn-end governance receipt anchors at the end of the flow', () => {
  assert.match(client, /RECEIPT_KIND = KIND \+ '-receipt'/)
  assert.match(client, /event\.type === 'turn\/end'/)
  assert.match(client, /jevKindOf\(event\.type\) === 'receipt'/)
  assert.match(client, /name: 'conversation\.chat\.node', key: RECEIPT_KIND/)
  assert.match(client, /JevReceiptView/)
  assert.match(client, /JEV 治理回执/)
})

test('host: turn/end emits a jev/receipt fallback event', () => {
  assert.match(loop, /type === 'turn\/end'/)
  assert.match(loop, /appendJev\(session, 'jev\/receipt'/)
  assert.match(loop, /kind: 'turn\/end'/)
})

test('ui: Phase 2 rich card design is restored in the bottom dock', () => {
  assert.match(client, /margin:8px auto;max-width:640px/)
  assert.match(client, /justify-content:center/)
  assert.match(client, /filter:drop-shadow\(0 0 4px rgba\(248,81,73,\.6\)\)/)
  assert.match(client, /h\(JevCard, \{ state: s, mode: m, receipt: !!receiptMode \}\)/)
  assert.match(client, /'JEV 治理回执'/)
  assert.doesNotMatch(client, /✅ JEV 治理回执/)
  assert.match(client, /lat \+ 'ms'/)
})

test('ui: live card renders every decision and gate, scrolling at capped height', () => {
  assert.match(client, /max-height:220px/)
  assert.match(client, /overflow-y:auto/)
  assert.match(client, /Full step-flow projection: every decision and every gate/)
  assert.match(client, /for \(const d of decs\)/)
  assert.match(client, /for \(const g of gates\)/)
})

test('ui: card header and footer stay fixed while only the body scrolls', () => {
  assert.match(client, /\.jev-card\{[^}]*display:flex;flex-direction:column;overflow:hidden/)
  assert.match(client, /\.jev-card-head\{[^}]*flex:0 0 auto/)
  assert.match(client, /\.jev-card-body\{[^}]*flex:1 1 auto;min-height:0;overflow-y:auto/)
  assert.match(client, /\.jev-kv\{[^}]*flex:0 0 auto/)
  assert.match(client, /className: 'jev-card-body' \}, shield, rows\), metrics, brand/)
})

test('ui: deep console shows the real-time decision stream', () => {
  assert.match(client, /\.jev-stream\{max-height:180px;overflow-y:auto/)
  assert.match(client, /const streamSec = h\('div', \{ className: 'jev-deep-sec'/)
  assert.match(client, /实时决策数据流/)
  assert.match(client, /streamSec, ladderSec, flowSec/)
})

test('ui: governance receipt fires on idle debounce without host turn/end', () => {
  assert.match(client, /function settleNow\(s\)/)
  assert.match(client, /function touchActivity\(s\)/)
  assert.match(client, /setTimeout\(\(\) => \{ settleNow\(hud\.latest\)/)
  assert.match(client, /4000/)
  assert.match(client, /function useSettled\(\)/)
  assert.match(client, /receipt: !!receiptMode/)
})

test('ui: four native slots stay hidden outside a started JEV session', () => {
  assert.match(client, /function jevVisible\(props\)/)
  assert.match(client, /function blankSession\(id\)/)
  assert.match(client, /function hasJevState\(\)/)
  assert.match(client, /function noteSession\(ev\)/)
  assert.match(client, /function JevLiveDock\(props\)/)
  assert.match(client, /function JevHud\(props\)/)
  assert.match(client, /function JevPill\(props\)/)
  assert.match(client, /function JevReceiptView\(props\)/)
  assert.match(client, /if \(!hasJevState\(\)\) return null/)
})


test('ui: all-turn ledger accumulates decisions, gates and savings', () => {
  for (const literal of [
    'let turnLedger = new Map()',
    'function recordJevEvent(ev)',
    'function savingRate(tokens, chars)',
    'function turnRows()',
    'function ledgerTotals()',
    'function enrichState(s)',
    'activateSession(sid)',
    'recordJevEvent(match.event)',
    'hud.latest = enrichState(s)',
  ]) assert.ok(client.includes(literal), 'missing: ' + literal)
})

test('ui: card shows per-turn rollup and all-turn totals with savings ratio', () => {
  for (const literal of [
    "' · 全会话 ' + tot.rounds + ' 轮 · '",
    "'第 ' + r.turn + ' 轮'",
    'jev-turn-row',
    "'合计'",
    "'省约 ' + fmtTok(savedT) + ' tokens · ' + tot.rate + '%'",
  ]) assert.ok(client.includes(literal), 'missing: ' + literal)
})

test('ui: deep console shows per-turn summary before the live stream', () => {
  assert.match(client, /const summarySec = h\('div', \{ className: 'jev-deep-sec'/)
  assert.match(client, /逐轮汇总/)
  assert.match(client, /summarySec, streamSec, ladderSec, flowSec, ruleSec, metrics, brand/)
})

test('host: jev events are persisted as host plugin records (log stays loadable)', () => {
  // Durability contract: never write a new bare top-level event type (that makes
  // the log unreadable on reopen). Use the host appendPluginRecord channel, which
  // stamps ignorable:true under the plugin: namespace.
  assert.match(loop, /const sid = session && \(session\.id \|\| session\.sessionId\)/)
  assert.match(loop, /Object\.assign\(\{\}, data, \{ sessionId: sid \}\)/)
  assert.match(loop, /appendPluginRecord\(session, pluginType, payload\)/)
  assert.match(loop, /'plugin:jev-harness\/'/)
  assert.match(loop, /function toPluginRecordType\(type\)/)
})

test('ui: card ledger is per-session and idempotent (no turn-1 inflation)', () => {
  // Regression: a single global ledger with no event dedupe double-counted an
  // earlier turn every time the host re-delivered history for a new turn.
  assert.match(client, /const ledgerBySession = new Map\(\)/)
  assert.match(client, /const seenBySession = new Map\(\)/)
  assert.match(client, /seen\.has\(key\)/)
  assert.match(client, /activateSession\(sid\)/)
})
