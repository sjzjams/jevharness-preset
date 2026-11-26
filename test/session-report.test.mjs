import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeSessionEvents } from '../shared/session-report.mjs'

const rec = (type, data) => ({ type, seq: 0, time: 0, data })

test('session-report: derives decisions/gates/turns/savings from session events', () => {
  const records = [
    rec('turn/start', { turn: 1 }),
    rec('plugin:jev-harness/decision', { turn: 1, step: 0, lines: { context_visibility: 'short_summary', cache: 'reuse', routing: 'frontier', tools: 'targeted', permissions: 'allow', security: 'internal' }, cacheFrozen: true, savedTokens: 100, ledgerChars: 400, latencyMs: 10 }),
    rec('plugin:jev-harness/gate', { turn: 1, verdict: 'deny', ruleId: 'r1' }),
    rec('turn/start', { turn: 2 }),
    rec('plugin:jev-harness/decision', { turn: 2, step: 0, lines: { context_visibility: 'hide', cache: 'rebuild', routing: 'frontier', tools: 'search_source', permissions: 'allow', security: 'sensitive' }, cacheFrozen: false, savedTokens: 0, ledgerChars: 0 }),
  ]
  const r = summarizeSessionEvents(records, { sessionId: 's1' })
  assert.equal(r.sessionId, 's1')
  assert.equal(r.turns, 2)
  assert.equal(r.totalDecisions, 2)
  assert.equal(r.totalGateEvents, 1)
  assert.equal(r.gateCounts.deny, 1)
  assert.equal(r.gateCounts.byRuleId.r1, 1)
  assert.equal(r.savedTokens, 100)
  assert.equal(r.ledgerChars, 400)
  assert.equal(r.savingRate, 1)
  assert.equal(r.cacheFrozenCount, 1)
  assert.equal(r.cacheReuseRate, 0.5)
  assert.deepEqual(r.distributions.visibility, { short_summary: 1, hide: 1 })
  assert.deepEqual(r.distributions.security, { internal: 1, sensitive: 1 })
})

test('session-report: zero decisions yields zeroed rates (no divide-by-zero)', () => {
  const r = summarizeSessionEvents([rec('turn/start', { turn: 1 })], { sessionId: 's2' })
  assert.equal(r.totalDecisions, 0)
  assert.equal(r.cacheReuseRate, 0)
  assert.equal(r.savingRate, 0)
  assert.equal(r.avgLatencyMs, 0)
})
