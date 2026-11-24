/**
 * JEVHarness / shared/live-bus.mjs
 *
 * In-memory, per-session ring buffer that records the SAME per-step decisions the
 * loop already pushes into the model context (system-prompt) and telemetry JSONL.
 *
 * Purpose: give the Web client a cheap, real-time projection channel WITHOUT
 * touching the model prompt or the KV-cache prefix. The host half of the loop
 * writes here; the client half polls/reads here via an RPC channel.
 *
 * Pure Node 20+ ESM, zero external dependencies. Fail-open: never throws.
 */

const DEFAULT_MAX_EVENTS = 400
const DEFAULT_ACTIVE_TTL_MS = 120000

/**
 * @param {{ maxEvents?: number, activeTtlMs?: number }} [options]
 */
export function createLiveBus(options = {}) {
  const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0
    ? options.maxEvents
    : DEFAULT_MAX_EVENTS
  const activeTtlMs = Number.isInteger(options.activeTtlMs) && options.activeTtlMs > 0
    ? options.activeTtlMs
    : DEFAULT_ACTIVE_TTL_MS

  /** @type {Map<string, any>} */
  const sessions = new Map()

  function entry(sessionId) {
    let e = sessions.get(sessionId)
    if (!e) {
      e = {
        isJev: false,
        seq: 0,
        events: [],
        lastDecision: null,
        turns: 0,
        updatedAt: 0,
        stats: {
          decisions: 0,
          gates: 0,
          denies: 0,
          asks: 0,
          cacheReuse: 0,
          latencySum: 0,
          latencyCount: 0,
          savedTokens: 0,
        },
      }
      sessions.set(sessionId, e)
    }
    return e
  }

  function markJev(sessionId) {
    if (!sessionId) return
    const e = entry(sessionId)
    e.isJev = true
    e.updatedAt = Date.now()
  }

  function setTurns(sessionId, turns) {
    if (!sessionId) return
    const e = entry(sessionId)
    if (typeof turns === 'number' && turns >= 0) e.turns = turns
  }

  /** @param {string} sessionId @param {Record<string, any>} ev */
  function push(sessionId, ev) {
    if (!sessionId || !ev || typeof ev !== 'object') return null
    const e = entry(sessionId)
    e.seq += 1
    const rec = { ...ev, seq: e.seq, ts: ev.ts || new Date().toISOString() }
    e.events.push(rec)
    if (e.events.length > maxEvents) e.events.splice(0, e.events.length - maxEvents)
    e.updatedAt = Date.now()

    if (rec.kind === 'decision') {
      e.lastDecision = rec
      e.stats.decisions += 1
      if (rec.cacheFrozen) e.stats.cacheReuse += 1
      if (typeof rec.latencyMs === 'number' && isFinite(rec.latencyMs)) {
        e.stats.latencySum += rec.latencyMs
        e.stats.latencyCount += 1
      }
      if (typeof rec.savedTokens === 'number' && isFinite(rec.savedTokens)) {
        e.stats.savedTokens += rec.savedTokens
      }
    } else if (rec.kind === 'gate') {
      e.stats.gates += 1
      if (rec.verdict === 'deny') e.stats.denies += 1
      else if (rec.verdict === 'ask') e.stats.asks += 1
    }
    return rec
  }

  function statsView(e) {
    if (!e) return null
    return {
      decisions: e.stats.decisions,
      gates: e.stats.gates,
      denies: e.stats.denies,
      asks: e.stats.asks,
      cacheReuse: e.stats.cacheReuse,
      savedTokens: e.stats.savedTokens,
      avgLatency: e.stats.latencyCount
        ? Math.round(e.stats.latencySum / e.stats.latencyCount)
        : 0,
    }
  }

  /** Events with seq > cursor. */
  function since(sessionId, cursor) {
    const e = sessions.get(sessionId)
    if (!e) {
      return { isJev: false, seq: 0, events: [], lastDecision: null, stats: null, turns: 0 }
    }
    const cur = typeof cursor === 'number' ? cursor : -1
    return {
      isJev: e.isJev,
      seq: e.seq,
      events: cur < 0 ? e.events.slice() : e.events.filter((x) => x.seq > cur),
      lastDecision: e.lastDecision,
      stats: statsView(e),
      turns: e.turns,
    }
  }

  /** Global liveness for a badge with no explicit session id. */
  function probe(now = Date.now()) {
    let latest = null
    let activeCount = 0
    for (const [sessionId, e] of sessions.entries()) {
      if (!e.isJev) continue
      if (now - e.updatedAt > activeTtlMs) continue
      activeCount += 1
      if (!latest || e.updatedAt > latest.updatedAt) {
        latest = {
          sessionId,
          seq: e.seq,
          turns: e.turns,
          isJev: true,
          lastDecision: e.lastDecision,
          stats: statsView(e),
          updatedAt: e.updatedAt,
        }
      }
    }
    return { activeCount, latest }
  }

  function clear(sessionId) {
    if (sessionId) sessions.delete(sessionId)
  }
  function clearAll() {
    sessions.clear()
  }

  return { markJev, push, setTurns, since, probe, clear, clearAll }
}
