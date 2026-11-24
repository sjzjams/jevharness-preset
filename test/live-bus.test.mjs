import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLiveBus } from '../shared/live-bus.mjs'
import { apply } from '../jev-harness-loop/index.mjs'

describe('shared/live-bus.mjs — in-memory real-time projection', () => {
  it('assigns monotonic seq, filters since(cursor), and computes stats', () => {
    const bus = createLiveBus()
    bus.markJev('s1')
    bus.push('s1', { kind: 'decision', step: 1, latencyMs: 40, cacheFrozen: true, savedTokens: 500, lines: { routing: 'frontier' } })
    bus.push('s1', { kind: 'gate', step: 1, verdict: 'deny', toolName: 'read' })
    bus.push('s1', { kind: 'decision', step: 2, latencyMs: 60, cacheFrozen: false, savedTokens: 300, lines: { routing: 'cheap' } })

    const full = bus.since('s1', -1)
    assert.equal(full.isJev, true)
    assert.equal(full.seq, 3)
    assert.equal(full.events.length, 3)
    assert.deepEqual(full.events.map((e) => e.seq), [1, 2, 3])
    assert.equal(full.stats.decisions, 2)
    assert.equal(full.stats.gates, 1)
    assert.equal(full.stats.denies, 1)
    assert.equal(full.stats.cacheReuse, 1)
    assert.equal(full.stats.savedTokens, 800)
    assert.equal(full.stats.avgLatency, 50)

    const tail = bus.since('s1', 1)
    assert.equal(tail.events.length, 2)
    assert.equal(tail.events[0].seq, 2)
  })

  it('caps the ring buffer and clears on demand', () => {
    const bus = createLiveBus({ maxEvents: 5 })
    bus.markJev('s1')
    for (let i = 0; i < 12; i++) bus.push('s1', { kind: 'step', step: i })
    const snap = bus.since('s1', -1)
    assert.equal(snap.events.length, 5)
    assert.equal(snap.seq, 12)
    assert.equal(snap.events[snap.events.length - 1].step, 11)

    bus.clear('s1')
    const after = bus.since('s1', -1)
    assert.equal(after.isJev, false)
    assert.equal(after.events.length, 0)
  })

  it('probe reports only fresh JEV sessions', () => {
    const bus = createLiveBus({ activeTtlMs: 1000 })
    const now = Date.now()
    bus.markJev('a')
    bus.push('a', { kind: 'decision', step: 1 })
    const p = bus.probe(now)
    assert.equal(p.activeCount, 1)
    assert.equal(p.latest.sessionId, 'a')
    const stale = bus.probe(now + 5000)
    assert.equal(stale.activeCount, 0)
  })
})

// --- end-to-end live channel through apply() ---
function makeJevBase(cwd) {
  const esc = cwd.replace(/\\/g, '\\\\')
  return {
    sections: [{ name: 'persona', text: 'You are an AI agent, running as a JeV harness.\n# JeV engineering contract' }],
    contexts: [{ name: 'session-env', text: 'Current working directory: "' + esc + '".\nCurrent DSH file policy: danger-full-access.\nApproval prompts are disabled in this session.' }],
  }
}
function makePtcBase(cwd) {
  return {
    sections: [{ name: 'persona', text: 'You are a standard DeepSeek Harness coding assistant (PTC preset).' }],
    contexts: [{ name: 'session-env', text: 'Current working directory: "' + cwd + '".' }],
  }
}

function createLiveCtx() {
  const listeners = new Map()
  const captured = { channel: null, handler: null }
  const ctx = {
    on(e, h) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(h) },
    tools: { register() {} },
    get(name) {
      if (name === 'connection') {
        return { rpc: { handle(ch, h) { captured.channel = ch; captured.handler = h; return () => {} } } }
      }
      return undefined
    },
    effect(fn) { try { return fn() } catch { return undefined } },
  }
  const emitSession = (s, e) => { for (const fn of listeners.get('session/event') || []) fn(s, e) }
  const emitDisposed = (p) => { for (const fn of listeners.get('agent/disposed') || []) fn(p) }
  async function runAssemble(base, context) {
    const hs = listeners.get('system-prompt/assemble') || []
    let i = 0
    const next = async () => (i >= hs.length ? base : hs[i++]({}, context, next))
    return next()
  }
  async function runPre(exec) {
    const hs = listeners.get('tools/pre-execute') || []
    let i = 0
    const next = async () => (i >= hs.length ? { kind: 'allow' } : hs[i++](exec, next))
    return next()
  }
  return { ctx, captured, emitSession, emitDisposed, runAssemble, runPre }
}

function mockFetch() {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'req-1' },
    async text() {
      return JSON.stringify({
        model: 'jev-1.14.0',
        answers: {
          context_visibility: { type: 'choice', choice: 'short_summary', confidence: 0.85 },
          cache_prefix: { type: 'noul', noul: 0.9, confidence: 0.85 },
          routing: { type: 'choice', choice: 'frontier', confidence: 0.9 },
          tools: { type: 'choice', choice: 'targeted', confidence: 0.8 },
          permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
          security: { type: 'score', score: 2, confidence: 0.85 },
        },
        usage: { input_tokens: 100, output_tokens: 12 },
      })
    },
  })
}

describe('jev-harness-loop — live projection channel end-to-end', () => {
  it('registers the channel, streams a decision + gate, and clears on dispose', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'jev-live-'))
    const telemetryDir = join(tmp, '.tel')
    try {
      const h = createLiveCtx()
      apply(h.ctx, { apiKey: 'test-key', fetchImpl: mockFetch(), telemetryDir, telemetryEnabled: false, throttleMs: 0 })
      assert.equal(h.captured.channel, '/jev-harness-live')
      assert.equal(typeof h.captured.handler, 'function')

      // Non-JEV session: assemble is untouched and bus stays empty.
      await h.runAssemble(makePtcBase(tmp), { toolSet: {}, agent: { session: { id: 'ptc' } } })
      const ptcSnap = await h.captured.handler('since', { sessionId: 'ptc', cursor: -1 })
      assert.equal(ptcSnap.ok, true)
      assert.equal(ptcSnap.value.isJev, false)

      // JEV session: user message + assemble -> decision event projected.
      h.emitSession({ id: 'jev1' }, { type: 'user/message', data: { content: [{ type: 'text', text: 'Inspect src/app.js safely' }] } })
      await h.runAssemble(makeJevBase(tmp), { toolSet: {}, agent: { session: { id: 'jev1' } } })

      const snap = await h.captured.handler('since', { sessionId: 'jev1', cursor: -1 })
      assert.equal(snap.ok, true)
      assert.equal(snap.value.isJev, true)
      const decisions = snap.value.events.filter((e) => e.kind === 'decision')
      assert.equal(decisions.length, 1)
      assert.equal(decisions[0].lines.routing, 'frontier')
      assert.equal(decisions[0].lines.context_visibility, 'short_summary')

      // Gate denied -> gate event projected after the cursor.
      await h.runPre({ name: 'read', args: { file_path: '.env' }, agent: { session: { id: 'jev1' } } })
      const snap2 = await h.captured.handler('since', { sessionId: 'jev1', cursor: snap.value.seq })
      const gates = snap2.value.events.filter((e) => e.kind === 'gate')
      assert.equal(gates.length, 1)
      assert.equal(gates[0].verdict, 'deny')

      // Probe sees the active JEV session.
      const probe = await h.captured.handler('probe', {})
      assert.equal(probe.ok, true)
      assert.ok(probe.value.activeCount >= 1)

      // Unknown endpoint is a typed error, not a throw.
      const bad = await h.captured.handler('nope', { sessionId: 'jev1' })
      assert.equal(bad.ok, false)

      // Dispose wipes the session from the bus.
      h.emitDisposed({ session: { id: 'jev1' } })
      const gone = await h.captured.handler('since', { sessionId: 'jev1', cursor: -1 })
      assert.equal(gone.value.isJev, false)
      assert.equal(gone.value.events.length, 0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
