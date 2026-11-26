/**
 * Session-log observability for JEVHarness.
 *
 * The UI (card / decision console) reads the durable session log, but the older
 * \`jev-report\` summarized the telemetry sidecar — which only records real LLM
 * calls and dedupes identical consecutive decisions, so it under-counted steps
 * and never carried token savings. This module summarizes the SESSION LOG
 * instead (the same source the UI trusts), and only borrows per-call token
 * usage from telemetry (reused steps genuinely cost 0 tokens).
 *
 * Shape matches @deepseek-ai/dsh companion summarizeDirectory so jev-report's
 * renderers keep working, plus extra fields: turns, savedTokens, ledgerChars,
 * savingRate.
 *
 * @module jevharness-preset/session-report
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { findSessionLogs, decodeAllFrames } from './session-log-repair.mjs'

export const DEFAULT_SESSIONS_DIR = join(homedir(), '.dsh', 'sessions')
export const DEFAULT_TELEMETRY_DIR = join(homedir(), '.dsh', 'jev-decisions')

const DECISION_RE = /(^jev\/|^plugin:jev-harness\/)decision$/
const GATE_RE = /(^jev\/|^plugin:jev-harness\/)gate$/

function inc(map, key) { if (key === null || key === undefined || key === '') return; map[key] = (map[key] || 0) + 1 }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }
function percentile(sorted, p) { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1)); return Number(sorted[i].toFixed(2)) }

function readTelemetryUsage(telemetryDir, sessionId) {
  const out = { input: 0, output: 0, latencies: [] }
  try {
    const p = join(telemetryDir, sessionId + '.jsonl')
    if (!existsSync(p)) return out
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      if (r && r.usage && typeof r.usage === 'object') { out.input += num(r.usage.input_tokens ?? r.usage.inputTokens); out.output += num(r.usage.output_tokens ?? r.usage.outputTokens) }
      if (r && typeof r.latencyMs === 'number' && r.latencyMs >= 0) out.latencies.push(r.latencyMs)
    }
  } catch { /* fail-open */ }
  return out
}

/** Summarize one decoded session log into a report row. */
export function summarizeSessionEvents(records, meta = {}) {
  const dist = { visibility: {}, routing: {}, tools: {}, permissions: {}, security: {} }
  const gateCounts = { allow: 0, ask: 0, deny: 0, byRuleId: {} }
  const latencies = []
  let decisions = 0, gates = 0, cacheFrozen = 0, cacheReuse = 0
  let savedTokens = 0, ledgerChars = 0
  let turns = 0
  for (const r of records) {
    if (r.type === 'turn/start') { const t = r.data && r.data.turn; if (typeof t === 'number') turns = Math.max(turns, t); else turns += 1 }
    if (DECISION_RE.test(r.type)) {
      const d = r.data || {}; const L = d.lines || {}
      decisions += 1
      inc(dist.visibility, L.context_visibility); inc(dist.routing, L.routing); inc(dist.tools, L.tools); inc(dist.permissions, L.permissions); inc(dist.security, L.security)
      if (d.cacheFrozen === true) cacheFrozen += 1
      if (L.cache === 'reuse') cacheReuse += 1
      if (typeof d.latencyMs === 'number' && d.latencyMs >= 0) latencies.push(d.latencyMs)
      savedTokens += num(d.savedTokens); ledgerChars += num(d.ledgerChars)
    } else if (GATE_RE.test(r.type)) {
      const g = r.data || {}; gates += 1
      const v = g.verdict === 'deny' ? 'deny' : g.verdict === 'ask' ? 'ask' : 'allow'
      gateCounts[v] += 1
      if (g.ruleId) gateCounts.byRuleId[g.ruleId] = (gateCounts.byRuleId[g.ruleId] || 0) + 1
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  const avgLatencyMs = latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : 0
  return {
    sessionId: meta.sessionId || (records[0] && records[0].id) || 'unknown',
    fileName: meta.fileName || '',
    format: meta.format || 'session-log',
    turns,
    totalDecisions: decisions,
    totalGateEvents: gates,
    cacheFrozenCount: cacheFrozen,
    cacheReuseRate: decisions > 0 ? Number((cacheReuse / decisions).toFixed(4)) : 0,
    avgLatencyMs,
    p95LatencyMs: percentile(sorted, 0.95),
    savedTokens,
    ledgerChars,
    savingRate: ledgerChars > 0 ? Number((savedTokens / (ledgerChars / 4)).toFixed(4)) : 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    distributions: dist,
    gateCounts,
  }
}

function emptySummary() { return { sessionCount: 0, turns: 0, totalDecisions: 0, totalGateEvents: 0, cacheFrozenCount: 0, cacheReuseRate: 0, avgLatencyMs: 0, p95LatencyMs: 0, savedTokens: 0, ledgerChars: 0, savingRate: 0, totalInputTokens: 0, totalOutputTokens: 0, distributions: { visibility: {}, routing: {}, tools: {}, permissions: {}, security: {} }, gateCounts: { allow: 0, ask: 0, deny: 0, byRuleId: {} } } }

function mergeInto(acc, s) {
  acc.sessionCount += 1
  acc.turns += s.turns; acc.totalDecisions += s.totalDecisions; acc.totalGateEvents += s.totalGateEvents
  acc.cacheFrozenCount += s.cacheFrozenCount; acc.savedTokens += s.savedTokens; acc.ledgerChars += s.ledgerChars
  acc.totalInputTokens += s.totalInputTokens; acc.totalOutputTokens += s.totalOutputTokens
  for (const dim of ['visibility', 'routing', 'tools', 'permissions', 'security']) for (const [k, v] of Object.entries(s.distributions[dim])) acc.distributions[dim][k] = (acc.distributions[dim][k] || 0) + v
  acc.gateCounts.allow += s.gateCounts.allow; acc.gateCounts.ask += s.gateCounts.ask; acc.gateCounts.deny += s.gateCounts.deny
  for (const [k, v] of Object.entries(s.gateCounts.byRuleId)) acc.gateCounts.byRuleId[k] = (acc.gateCounts.byRuleId[k] || 0) + v
  return acc
}

/** Summarize a tree of session logs (default ~/.dsh/sessions). */
export function summarizeSessionsDirectory(root = DEFAULT_SESSIONS_DIR, options = {}) {
  const telemetryDir = options.telemetryDir || DEFAULT_TELEMETRY_DIR
  const acc = emptySummary()
  const latencies = []
  const sessions = []
  let files = []
  try { files = findSessionLogs(root) } catch { files = [] }
  for (const file of files) {
    let records
    try { records = decodeAllFrames(readFileSync(file)).text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l)) } catch { continue }
    if (!records.length) continue
    const row = summarizeSessionEvents(records, { fileName: basename(file), format: 'session-log' })
    if (row.totalDecisions === 0 && row.turns === 0) continue
    // Only report sessions that actually used JEVHarness (had JeV events) — pure
    // base sessions would otherwise flood the report with zero rows.
    if (!records.some((r) => typeof r.type === 'string' && /jev-harness\//.test(r.type))) continue
    const u = readTelemetryUsage(telemetryDir, row.sessionId)
    row.totalInputTokens = u.input; row.totalOutputTokens = u.output
    for (const v of u.latencies) latencies.push(v)
    sessions.push(row)
    mergeInto(acc, row)
  }
  const sorted = [...latencies].sort((a, b) => a - b)
  acc.avgLatencyMs = latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : 0
  acc.p95LatencyMs = percentile(sorted, 0.95)
  acc.cacheReuseRate = acc.totalDecisions > 0 ? Number((sessions.reduce((a, s) => a + s.cacheReuseRate * s.totalDecisions, 0) / acc.totalDecisions).toFixed(4)) : 0
  acc.savingRate = acc.ledgerChars > 0 ? Number((acc.savedTokens / (acc.ledgerChars / 4)).toFixed(4)) : 0
  return { dir: root, telemetryDir, sessionCount: sessions.length, sessions, summary: acc }
}
