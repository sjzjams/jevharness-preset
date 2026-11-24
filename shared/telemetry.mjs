/**
 * JEVHarness / shared/telemetry.mjs
 *
 * Asynchronous, fail-open JSONL telemetry logger and offline log summarizer.
 * Pure Node 20+ ESM, zero external dependencies.
 *
 * Design guarantees:
 * - Zero synchronous full-file reads (in-memory Map deduplication).
 * - Per-session Promise write queues with fs.promises.mkdir + appendFile.
 * - Strict session filename sanitization against path traversal.
 * - Fail-open I/O: disk errors are swallowed and never crash the host.
 * - Backward-compatible parser for legacy v1 markdown decision logs.
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'

export const DEFAULT_TELEMETRY_DIR = join(homedir(), '.dsh', 'jev-decisions')

const MAX_SAFE_ID_LEN = 80

/**
 * Sanitize a session ID into a safe single-segment filename stem that cannot
 * escape its parent directory via path traversal or invalid OS characters.
 * @param {unknown} sessionId
 * @returns {string}
 */
export function sanitizeSessionId(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim() : String(sessionId ?? '').trim()
  if (!raw) return 'unknown'

  const hash = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 8)
  const hadUnsafe =
    /[^a-zA-Z0-9._-]/.test(raw) ||
    raw.includes('..') ||
    raw.startsWith('.') ||
    raw.length > MAX_SAFE_ID_LEN

  let cleaned = raw
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')

  if (!cleaned) cleaned = 'session'

  if (hadUnsafe) {
    const stem = cleaned.slice(0, MAX_SAFE_ID_LEN - 9) || 'session'
    return `${stem}_${hash}`
  }

  return cleaned
}

function resolveSafeFile(dir, fileName) {
  const resolvedDir = resolve(dir)
  const resolvedTarget = resolve(resolvedDir, fileName)
  const rel = relative(resolvedDir, resolvedTarget)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refused unsafe telemetry path: ${fileName}`)
  }
  return resolvedTarget
}

function buildDecisionLineFromParsed(parsed) {
  if (!parsed || typeof parsed !== 'object') return ''
  const parts = []
  const vis = parsed.context_visibility?.level ?? (typeof parsed.context_visibility === 'string' ? parsed.context_visibility : null)
  const cache = parsed.cache_prefix?.action ?? (typeof parsed.cache_prefix?.reuse === 'boolean' ? (parsed.cache_prefix.reuse ? 'reuse' : 'rebuild') : null)
  const routing = parsed.routing?.value ?? (typeof parsed.routing === 'string' ? parsed.routing : null)
  const tools = parsed.tools?.value ?? (typeof parsed.tools === 'string' ? parsed.tools : null)
  const perm = parsed.permissions?.action ?? parsed.permissions?.value ?? (typeof parsed.permissions === 'string' ? parsed.permissions : null)
  const sec = parsed.security?.level ?? (typeof parsed.security === 'string' ? parsed.security : null)

  if (vis) parts.push(`context_visibility=${vis}`)
  if (cache) parts.push(`cache=${cache}`)
  if (routing) parts.push(`routing=${routing}`)
  if (tools) parts.push(`tools=${tools}`)
  if (perm !== null && perm !== undefined) parts.push(`permissions=${perm}`)
  if (sec) parts.push(`security=${sec}`)
  return parts.join('; ')
}

function extractParsedSignature(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  return {
    vis: parsed.context_visibility?.level ?? parsed.context_visibility ?? null,
    cache: parsed.cache_prefix?.action ?? parsed.cache_prefix?.reuse ?? null,
    routing: parsed.routing?.value ?? parsed.routing ?? null,
    tools: parsed.tools?.value ?? parsed.tools ?? null,
    permissions: parsed.permissions?.action ?? parsed.permissions?.value ?? parsed.permissions ?? null,
    security: parsed.security?.level ?? parsed.security ?? null,
  }
}

function computeDecisionSignature(record) {
  return JSON.stringify([
    record.model ?? null,
    record.decisionLine ?? '',
    record.cacheFrozen ? 1 : 0,
    record.chunkCount ?? 0,
    record.conditionalRulesCount ?? 0,
    extractParsedSignature(record.parsed),
  ])
}

/**
 * Create an asynchronous, fail-open telemetry logger.
 * @param {{ dir?: string, writeLegacyMarkdown?: boolean }} [options]
 */
export function createTelemetryLogger({ dir = DEFAULT_TELEMETRY_DIR, writeLegacyMarkdown = false } = {}) {
  const targetDir = typeof dir === 'string' && dir.trim() ? dir.trim() : DEFAULT_TELEMETRY_DIR
  const legacyEnabled = Boolean(writeLegacyMarkdown)

  /** @type {Map<string, string>} */
  const lastSignatures = new Map()
  /** @type {Map<string, Promise<void>>} */
  const writeQueues = new Map()

  function enqueueWrite(safeId, taskFn) {
    const prev = writeQueues.get(safeId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(async () => {
        try {
          await mkdir(targetDir, { recursive: true })
          await taskFn()
        } catch {
          // Fail-open: never surface disk or permission errors to caller.
        }
      })
    writeQueues.set(safeId, next)
    return next
  }

  function recordDecision(sessionId, entry = {}) {
    try {
      const rawSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'unknown'
      const safeId = sanitizeSessionId(rawSessionId)
      const data = entry && typeof entry === 'object' ? entry : {}

      const ts = typeof data.ts === 'string' && data.ts ? data.ts : new Date().toISOString()
      const decisionLine =
        typeof data.decisionLine === 'string' && data.decisionLine.length > 0
          ? data.decisionLine
          : buildDecisionLineFromParsed(data.parsed)

      const record = {
        type: 'decision',
        ts,
        sessionId: rawSessionId,
        model: typeof data.model === 'string' ? data.model : null,
        decisionLine,
        parsed: data.parsed ?? null,
        latencyMs:
          typeof data.latencyMs === 'number' && Number.isFinite(data.latencyMs) && data.latencyMs >= 0
            ? data.latencyMs
            : null,
        usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
        chunkCount: Number.isFinite(data.chunkCount) ? Number(data.chunkCount) : 0,
        conditionalRulesCount: Number.isFinite(data.conditionalRulesCount) ? Number(data.conditionalRulesCount) : 0,
        cacheFrozen: Boolean(data.cacheFrozen),
      }

      const sig = computeDecisionSignature(record)
      if (data.dedupe !== false && lastSignatures.get(safeId) === sig) {
        return writeQueues.get(safeId) ?? Promise.resolve()
      }
      lastSignatures.set(safeId, sig)

      const jsonlLine = JSON.stringify(record) + '\n'
      const legacyLine = legacyEnabled
        ? `- ${record.ts} · ${record.decisionLine || '(empty)'}\n`
        : null

      return enqueueWrite(safeId, async () => {
        const jsonlPath = resolveSafeFile(targetDir, `${safeId}.jsonl`)
        await appendFile(jsonlPath, jsonlLine, 'utf8')
        if (legacyLine) {
          const mdPath = resolveSafeFile(targetDir, `${safeId}.md`)
          await appendFile(mdPath, legacyLine, 'utf8')
        }
      })
    } catch {
      return Promise.resolve()
    }
  }

  function recordGateEvent(sessionId, event = {}) {
    try {
      const rawSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'unknown'
      const safeId = sanitizeSessionId(rawSessionId)
      const data = event && typeof event === 'object' ? event : {}

      const record = {
        type: 'gate',
        ts: typeof data.ts === 'string' && data.ts ? data.ts : new Date().toISOString(),
        sessionId: rawSessionId,
        toolName: typeof data.toolName === 'string' ? data.toolName : '',
        kind: typeof data.kind === 'string' ? data.kind : 'allow',
        ruleId: typeof data.ruleId === 'string' ? data.ruleId : 'unknown',
        reason: typeof data.reason === 'string' ? data.reason : '',
      }

      const jsonlLine = JSON.stringify(record) + '\n'

      return enqueueWrite(safeId, async () => {
        const jsonlPath = resolveSafeFile(targetDir, `${safeId}.jsonl`)
        await appendFile(jsonlPath, jsonlLine, 'utf8')
      })
    } catch {
      return Promise.resolve()
    }
  }

  async function flush(sessionId) {
    try {
      if (sessionId !== undefined && sessionId !== null) {
        const safeId = sanitizeSessionId(sessionId)
        const pending = writeQueues.get(safeId)
        if (pending) await pending
        return
      }
      await Promise.allSettled(Array.from(writeQueues.values()))
    } catch {
      // Fail-open
    }
  }

  function clearSession(sessionId) {
    try {
      const safeId = sanitizeSessionId(sessionId)
      lastSignatures.delete(safeId)
    } catch {
      // Fail-open
    }
  }

  return {
    recordDecision,
    recordGateEvent,
    flush,
    clearSession,
  }
}

function createEmptyAccumulator() {
  return {
    totalDecisions: 0,
    totalGateEvents: 0,
    cacheFrozenCount: 0,
    cacheReuseCount: 0,
    latencies: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    distributions: {
      visibility: {},
      routing: {},
      tools: {},
      permissions: {},
      security: {},
    },
    gateCounts: {
      allow: 0,
      ask: 0,
      deny: 0,
      byRuleId: {},
    },
  }
}

function inc(map, key) {
  if (!key) return
  map[key] = (map[key] || 0) + 1
}

function normalizePermissionValue(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase()
    if (!trimmed || trimmed === '?') return null
    const base = trimmed.replace(/\(.*\)$/, '').trim()
    if (base === 'allow' || base === 'ask' || base === 'deny') return base
    if (base === 'true') return 'allow'
    if (base === 'false') return 'deny'
    const num = Number(base)
    if (!Number.isNaN(num)) {
      return num < 0.2 ? 'ask' : 'allow'
    }
    return base
  }
  if (typeof raw === 'number' && !Number.isNaN(raw)) {
    return raw < 0.2 ? 'ask' : 'allow'
  }
  if (typeof raw === 'boolean') {
    return raw ? 'allow' : 'deny'
  }
  return null
}

function parseDecisionLineFields(decisionLine) {
  if (typeof decisionLine !== 'string' || !decisionLine) return {}
  const out = {}
  const visM = /\bcontext_visibility=([a-zA-Z0-9_-]+)/.exec(decisionLine)
  if (visM) out.visibility = visM[1].toLowerCase()

  const cacheM = /\bcache=([a-zA-Z0-9_-]+)/.exec(decisionLine)
  if (cacheM) out.cache = cacheM[1].toLowerCase()

  const routingM = /\brouting=([a-zA-Z0-9_-]+)/.exec(decisionLine)
  if (routingM) out.routing = routingM[1].toLowerCase()

  const toolsM = /\btools=([a-zA-Z0-9_-]+)/.exec(decisionLine)
  if (toolsM) out.tools = toolsM[1].toLowerCase()

  const permM = /\bpermissions=([a-zA-Z0-9._-]+)/.exec(decisionLine)
  if (permM) out.permissions = normalizePermissionValue(permM[1])

  const secM = /\bsecurity=([a-zA-Z0-9_-]+)/.exec(decisionLine)
  if (secM) out.security = secM[1].toLowerCase()

  return out
}

function extractTokenCount(usage, keys) {
  if (!usage || typeof usage !== 'object') return 0
  for (const k of keys) {
    const v = usage[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return 0
}

function computeLatencyStats(latencies) {
  if (!latencies || latencies.length === 0) {
    return { avgLatencyMs: 0, p95LatencyMs: 0 }
  }
  let sum = 0
  for (const v of latencies) sum += v
  const avg = Number((sum / latencies.length).toFixed(2))
  const sorted = [...latencies].sort((a, b) => a - b)
  const p95Idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1))
  const p95 = Number(sorted[p95Idx].toFixed(2))
  return { avgLatencyMs: avg, p95LatencyMs: p95 }
}

function finalizeAccumulator(acc) {
  const { avgLatencyMs, p95LatencyMs } = computeLatencyStats(acc.latencies)
  const cacheReuseRate =
    acc.totalDecisions > 0 ? Number((acc.cacheReuseCount / acc.totalDecisions).toFixed(4)) : 0

  return {
    totalDecisions: acc.totalDecisions,
    totalGateEvents: acc.totalGateEvents,
    cacheFrozenCount: acc.cacheFrozenCount,
    cacheReuseRate,
    avgLatencyMs,
    p95LatencyMs,
    totalInputTokens: acc.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens,
    distributions: {
      visibility: { ...acc.distributions.visibility },
      routing: { ...acc.distributions.routing },
      tools: { ...acc.distributions.tools },
      permissions: { ...acc.distributions.permissions },
      security: { ...acc.distributions.security },
    },
    gateCounts: {
      allow: acc.gateCounts.allow,
      ask: acc.gateCounts.ask,
      deny: acc.gateCounts.deny,
      byRuleId: { ...acc.gateCounts.byRuleId },
    },
  }
}

function ingestDecisionRecord(acc, rec) {
  acc.totalDecisions += 1

  const parsed = rec.parsed && typeof rec.parsed === 'object' ? rec.parsed : null
  const fromLine = parseDecisionLineFields(rec.decisionLine)

  const visibility =
    parsed?.context_visibility?.level ||
    (typeof parsed?.context_visibility === 'string' ? parsed.context_visibility : null) ||
    fromLine.visibility ||
    null

  const routing =
    parsed?.routing?.value ||
    (typeof parsed?.routing === 'string' ? parsed.routing : null) ||
    fromLine.routing ||
    null

  const tools =
    parsed?.tools?.value ||
    (typeof parsed?.tools === 'string' ? parsed.tools : null) ||
    fromLine.tools ||
    null

  const permissions =
    normalizePermissionValue(
      parsed?.permissions?.action ?? parsed?.permissions?.value ?? parsed?.permissions
    ) ||
    fromLine.permissions ||
    null

  const security =
    parsed?.security?.level ||
    (typeof parsed?.security === 'string' ? parsed.security : null) ||
    fromLine.security ||
    null

  inc(acc.distributions.visibility, visibility)
  inc(acc.distributions.routing, routing)
  inc(acc.distributions.tools, tools)
  inc(acc.distributions.permissions, permissions)
  inc(acc.distributions.security, security)

  const cacheReused =
    rec.cacheFrozen === true ||
    parsed?.cache_prefix?.reuse === true ||
    parsed?.cache_prefix?.action === 'reuse' ||
    fromLine.cache === 'reuse'

  if (rec.cacheFrozen === true) acc.cacheFrozenCount += 1
  if (cacheReused) acc.cacheReuseCount += 1

  if (typeof rec.latencyMs === 'number' && Number.isFinite(rec.latencyMs) && rec.latencyMs >= 0) {
    acc.latencies.push(rec.latencyMs)
  }

  acc.totalInputTokens += extractTokenCount(rec.usage, [
    'input_tokens',
    'prompt_tokens',
    'inputTokens',
    'promptTokens',
  ])
  acc.totalOutputTokens += extractTokenCount(rec.usage, [
    'output_tokens',
    'completion_tokens',
    'outputTokens',
    'completionTokens',
  ])
}

function ingestGateRecord(acc, rec) {
  acc.totalGateEvents += 1
  const kind = typeof rec.kind === 'string' ? rec.kind.toLowerCase() : ''
  if (kind === 'allow' || kind === 'ask' || kind === 'deny') {
    acc.gateCounts[kind] += 1
  }
  const ruleId = typeof rec.ruleId === 'string' && rec.ruleId.trim() ? rec.ruleId.trim() : 'unknown'
  inc(acc.gateCounts.byRuleId, ruleId)
}

function parseJsonlIntoAccumulator(jsonlText, acc) {
  if (typeof jsonlText !== 'string' || !jsonlText) return
  const lines = jsonlText.split(/\r?\n/)
  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    let rec
    try {
      rec = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue

    if (rec.type === 'gate') {
      ingestGateRecord(acc, rec)
    } else if (rec.type === 'decision' || rec.parsed || rec.decisionLine) {
      ingestDecisionRecord(acc, rec)
    }
  }
}

const LEGACY_MD_LINE_RE = /^\s*-\s+([^·\n]+?)\s*·\s*(context_visibility=.+)$/

function parseLegacyMarkdownIntoAccumulator(mdText, acc) {
  if (typeof mdText !== 'string' || !mdText) return
  const lines = mdText.split(/\r?\n/)
  for (const rawLine of lines) {
    const m = LEGACY_MD_LINE_RE.exec(rawLine)
    if (!m) continue
    const decisionLine = m[2].trim()
    const fields = parseDecisionLineFields(decisionLine)
    acc.totalDecisions += 1
    inc(acc.distributions.visibility, fields.visibility)
    inc(acc.distributions.routing, fields.routing)
    inc(acc.distributions.tools, fields.tools)
    inc(acc.distributions.permissions, fields.permissions)
    inc(acc.distributions.security, fields.security)
    if (fields.cache === 'reuse') {
      acc.cacheReuseCount += 1
    }
  }
}

/**
 * Parse JSONL telemetry text (skipping malformed lines) and compute summary metrics.
 * @param {string} jsonlText
 */
export function summarizeJsonl(jsonlText) {
  const acc = createEmptyAccumulator()
  parseJsonlIntoAccumulator(jsonlText, acc)
  return finalizeAccumulator(acc)
}

/**
 * Parse legacy v1 Markdown decision log text (`- <ts> · context_visibility=...`).
 * @param {string} mdText
 */
export function summarizeLegacyMarkdown(mdText) {
  const acc = createEmptyAccumulator()
  parseLegacyMarkdownIntoAccumulator(mdText, acc)
  return finalizeAccumulator(acc)
}

function mergeAccumulators(target, source) {
  target.totalDecisions += source.totalDecisions
  target.totalGateEvents += source.totalGateEvents
  target.cacheFrozenCount += source.cacheFrozenCount
  target.cacheReuseCount += source.cacheReuseCount
  for (const lat of source.latencies) target.latencies.push(lat)
  target.totalInputTokens += source.totalInputTokens
  target.totalOutputTokens += source.totalOutputTokens

  for (const dim of ['visibility', 'routing', 'tools', 'permissions', 'security']) {
    for (const [k, v] of Object.entries(source.distributions[dim])) {
      target.distributions[dim][k] = (target.distributions[dim][k] || 0) + v
    }
  }

  target.gateCounts.allow += source.gateCounts.allow
  target.gateCounts.ask += source.gateCounts.ask
  target.gateCounts.deny += source.gateCounts.deny
  for (const [ruleId, count] of Object.entries(source.gateCounts.byRuleId)) {
    target.gateCounts.byRuleId[ruleId] = (target.gateCounts.byRuleId[ruleId] || 0) + count
  }
}

/**
 * Asynchronously scan a telemetry directory for .jsonl and legacy .md logs,
 * aggregating global metrics and per-session breakdowns.
 * When both <id>.jsonl and <id>.md exist, .jsonl takes precedence to avoid double counting.
 * @param {string} [dir=DEFAULT_TELEMETRY_DIR]
 */
export async function summarizeDirectory(dir = DEFAULT_TELEMETRY_DIR) {
  const targetDir = typeof dir === 'string' && dir.trim() ? dir.trim() : DEFAULT_TELEMETRY_DIR
  const globalAcc = createEmptyAccumulator()
  const sessions = []

  let entries = []
  try {
    entries = await readdir(targetDir, { withFileTypes: true })
  } catch {
    return {
      dir: targetDir,
      sessionCount: 0,
      sessions: [],
      summary: finalizeAccumulator(globalAcc),
    }
  }

  const jsonlStems = new Set()
  const candidateFiles = []

  for (const ent of entries) {
    if (!ent.isFile()) continue
    const ext = extname(ent.name).toLowerCase()
    if (ext === '.jsonl') {
      const stem = basename(ent.name, extname(ent.name))
      jsonlStems.add(stem)
      candidateFiles.push({ name: ent.name, stem, format: 'jsonl' })
    } else if (ext === '.md') {
      const stem = basename(ent.name, extname(ent.name))
      candidateFiles.push({ name: ent.name, stem, format: 'markdown' })
    }
  }

  // Prefer .jsonl over .md when both exist for the same session stem
  const selected = candidateFiles
    .filter((f) => f.format === 'jsonl' || !jsonlStems.has(f.stem))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  for (const file of selected) {
    let text = ''
    try {
      text = await readFile(join(targetDir, file.name), 'utf8')
    } catch {
      continue
    }

    const sessionAcc = createEmptyAccumulator()
    if (file.format === 'jsonl') {
      parseJsonlIntoAccumulator(text, sessionAcc)
    } else {
      parseLegacyMarkdownIntoAccumulator(text, sessionAcc)
    }

    mergeAccumulators(globalAcc, sessionAcc)

    // Attempt to extract original sessionId from first JSONL line if available
    let displaySessionId = file.stem
    if (file.format === 'jsonl') {
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim()
        if (!t) continue
        try {
          const obj = JSON.parse(t)
          if (obj && typeof obj.sessionId === 'string' && obj.sessionId.trim()) {
            displaySessionId = obj.sessionId.trim()
            break
          }
        } catch {
          continue
        }
      }
    }

    sessions.push({
      sessionId: displaySessionId,
      fileName: file.name,
      format: file.format,
      ...finalizeAccumulator(sessionAcc),
    })
  }

  return {
    dir: targetDir,
    sessionCount: sessions.length,
    sessions,
    summary: finalizeAccumulator(globalAcc),
  }
}
