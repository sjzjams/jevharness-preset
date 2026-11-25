/**
 * JEVHarness / jev-harness-loop (v2)
 *
 * Preset-scoped Cordis plugin turning the JeV engineering contract
 * ("JEV ENGINEERING FOR CODING AGENTS") into an enforceable per-step loop:
 *
 * - Strict per-session state isolation (Map<sessionId, SessionState>, zero global singleton)
 * - Explicit typed chunk store with per-chunk visibility scoring & on-demand recall
 * - KV-cache-friendly decision header freezing with bucketed confidences
 * - Condition-bound rules (§VIII) reloaded every step, immune to compaction
 * - Programmable permission & Table IV routing trust gates (§IV.A, §IX)
 * - Subgoal deduplication & read/write path locking (§VI.A, §VI.B)
 * - Shared read-only retrieval pack export (§X)
 * - Async fail-open telemetry via shared/telemetry.mjs
 *
 * Pure Node 20+ ESM, zero external dependencies.
 */
import { callSystemOne, DEFAULT_MODEL } from '../shared/gateway.mjs'
import { buildStepQuestions, parseDecision, bucketConfidence } from '../shared/answers.mjs'
import { DEFAULT_POLICY, evaluateToolGate, classifyRunCodeAccess } from '../shared/policy.mjs'
import { createChunkStore } from '../shared/chunk-store.mjs'
import { loadConditionalRules } from '../shared/conditional-rules.mjs'
import { createSubgoalTracker } from '../shared/subgoal-tracker.mjs'
import { createTelemetryLogger } from '../shared/telemetry.mjs'
import { createLiveBus } from '../shared/live-bus.mjs'
import { repairAll } from '../shared/session-log-repair.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'


// ---------------------------------------------------------------------------
// Durable event persistence — host plugin-record channel only.
//
// The harness session-event vocabulary is CLOSED: writing a new top-level event
// type through session.append(type, data) makes the entire log unreadable the
// next time it is opened ("event type ... unknown to this harness and not marked
// ignorable; refusing to interpret the log"). Live session.append also offers no
// way to set the envelope's `ignorable` marker. The ONLY supported mechanism for
// an out-of-tree plugin is appendPluginRecord(session, 'plugin:<ns>/<name>', data),
// which stamps ignorable:true and keeps the log forward/backward compatible.
//
// It is imported lazily and must resolve to the HOST's single module instance:
// a second copy of the module has its own private #appendRecord and cannot touch
// host Session instances. We never fall back to session.append for new types —
// failing open to a no-op only loses the UI card, never the ability to reopen.
// ---------------------------------------------------------------------------
let _hostSessionModulePromise = null
function loadHostSessionModule() {
  if (_hostSessionModulePromise === null) {
    _hostSessionModulePromise = (async () => {
      // A link:-installed preset cannot resolve '@deepseek-ai/*' by Node's normal
      // package lookup (the host packages live inside app.asar). Try the host's
      // own asar module path first (same file URL the host loaded => same ESM
      // module instance, so appendPluginRecord can touch host Session objects),
      // then fall back to the bare specifier.
      const candidates = []
      try {
        const path = await import('node:path')
        const url = await import('node:url')
        const res = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
        if (res) {
          for (const sub of ['app.asar', 'app.asar.unpacked']) {
            const p = path.join(res, sub, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js')
            candidates.push(url.pathToFileURL(p).href)
          }
        }
      } catch { /* ignore */ }
      candidates.push('@deepseek-ai/dsh-session')
      for (const spec of candidates) {
        try {
          const m = await import(spec)
          if (m && typeof m.appendPluginRecord === 'function') return m
        } catch { /* try next */ }
      }
      return null
    })()
  }
  return _hostSessionModulePromise
}
/** Map a legacy `jev/<name>` UI event type onto the plugin-record namespace. */
function toPluginRecordType(type) {
  return typeof type === 'string' && type.startsWith('jev/')
    ? 'plugin:jev-harness/' + type.slice('jev/'.length)
    : (typeof type === 'string' && type.startsWith('plugin:') ? type : 'plugin:jev-harness/' + type)
}

export const name = 'jev-harness-loop'
export const inject = ['tools']

/** Marker present only in a JEVHarness agent's system prompt (its persona). */
const JEV_MARKERS = Object.freeze([
  'JeV engineering contract',
  'running as a JeV harness',
])

const DEFAULT_TIMEOUT_MS = 8000
const DEFAULT_THROTTLE_MS = 1200
const DEFAULT_DECISION_TTL_MS = 60000
const DEFAULT_CONDITIONAL_RULES_MAX_BYTES = 4096
const DEFAULT_CHUNK_DIGEST_MAX_CHARS = 2400
const DEFAULT_SUBGOAL_INFLIGHT_TTL_MS = 30 * 60 * 1000
const MAX_ACTIVE_PATHS = 32
const MAX_RECENT_TOOLS = 16
const JEV_LIVE_CHANNEL = '/jev-harness-live'

const DEPLOY_GOAL_RE = /\bdeploy(?:ment|ing|ed)?\b|发布|部署/i
const CWD_LINE_RE = /Current working directory:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n]+))/i
const FILE_POLICY_LINE_RE = /Current DSH file policy:\s*([a-z0-9_-]+)/i
const APPROVAL_DISABLED_RE = /Approval prompts are disabled/i

const SECRET_CONTENT_RE = /(?:-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bMAGPIE_GATEWAY_KEY\s*=|\b(?:sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16})\b)/
const PUBLIC_SOURCE_RE = /(?:^|[\\/])(?:readme(?:\.[a-z]+)?|license(?:\.[a-z]+)?|changelog\.md|docs[\\/]|node_modules[\\/])/i
const PATH_TOKEN_RE = /(?:@(?:"([^"]+)"|([^\s'"`),;]+))|(?:[A-Za-z]:\\[^\s'"`),;]+)|(?:(?:\.{1,2}[\\/]|[a-zA-Z0-9_.-]+[\\/])+[a-zA-Z0-9_.-]+(?:\.[a-zA-Z0-9_-]+)?))/g
const PATH_ARG_KEYS = Object.freeze([
  'path',
  'file_path',
  'filePath',
  'target',
  'dir',
  'cwd',
  'filename',
  'file',
  'src',
  'dest',
  'destination',
  'source',
  'output',
  'input',
])
const WRITE_INTENT_RE = /\b(?:edit|write|modify|update|refactor|create|delete|remove|fix|implement|patch|rename|rewrite|migrate|apply)\b|修改|编辑|写入|重构|创建|删除|实现|修复|替换|改写/i
const READ_ONLY_INTENT_RE = /\b(?:read[-\s]?only|do not modify|don't modify|no edits|inspect only|audit only|review only)\b|只读|不要修改|仅查看|仅检查/i

/**
 * Resolve a sessionId cleanly from various DSH hook payloads.
 * Avoids confusing a tool execution's call id (exec.id) with sessionId.
 *
 * @param {unknown} payload
 * @param {'session' | 'context' | 'exec' | 'disposed' | 'auto'} [kind='auto']
 * @returns {string | null}
 */
export function resolveSessionId(payload, kind = 'auto') {
  if (typeof payload === 'string') {
    const s = payload.trim()
    return s || null
  }
  if (!payload || typeof payload !== 'object') return null

  const p = /** @type {any} */ (payload)
  let raw = null

  if (kind === 'session') {
    raw = p.id ?? p.sessionId ?? p.session?.id ?? null
  } else if (kind === 'context') {
    raw =
      p.agent?.session?.id ??
      p.scope?.session?.id ??
      p.session?.id ??
      p.sessionId ??
      null
  } else if (kind === 'exec') {
    raw =
      p.agent?.session?.id ??
      p.scope?.session?.id ??
      p.session?.id ??
      p.sessionId ??
      null
  } else if (kind === 'disposed') {
    raw =
      p.session?.id ??
      p.agent?.session?.id ??
      p.scope?.session?.id ??
      p.sessionId ??
      null
  } else {
    raw =
      p.agent?.session?.id ??
      p.scope?.session?.id ??
      p.session?.id ??
      p.sessionId ??
      p.id ??
      null
  }

  if (raw === null || raw === undefined) return null
  const str = String(raw).trim()
  return str || null
}

function unescapePathMatch(raw) {
  if (!raw) return ''
  return String(raw)
    .trim()
    .replace(/\\\\/g, '\\')
    .replace(/[.,;]+$/, '')
    .trim()
}

function addActivePath(state, candidate) {
  if (typeof candidate !== 'string') return
  const trimmed = candidate.trim().replace(/^['"`]|['"`]$/g, '').replace(/[.,;:]+$/, '')
  if (!trimmed || trimmed.length > 260) return
  if (/^[a-z]+:\/\//i.test(trimmed)) return
  if (state.activePaths.has(trimmed)) {
    state.activePaths.delete(trimmed)
  }
  state.activePaths.add(trimmed)
  while (state.activePaths.size > MAX_ACTIVE_PATHS) {
    const oldest = state.activePaths.values().next().value
    if (oldest === undefined) break
    state.activePaths.delete(oldest)
  }
}

function pushRecentTool(state, toolName) {
  if (typeof toolName !== 'string') return
  const trimmed = toolName.trim()
  if (!trimmed) return
  state.recentTools.push(trimmed)
  if (state.recentTools.length > MAX_RECENT_TOOLS) {
    state.recentTools.splice(0, state.recentTools.length - MAX_RECENT_TOOLS)
  }
}

function extractPathsFromText(text) {
  if (typeof text !== 'string' || !text.trim()) return []
  const out = []
  PATH_TOKEN_RE.lastIndex = 0
  let m
  while ((m = PATH_TOKEN_RE.exec(text)) !== null) {
    const raw = (m[1] || m[2] || m[0] || '').trim()
    if (!raw) continue
    if (/^[a-z]+:\/\//i.test(raw)) continue
    const cleaned = raw.replace(/^@/, '').replace(/[.,;:!?)]+$/, '')
    if (cleaned && cleaned.length >= 2 && cleaned.length <= 260) {
      out.push(cleaned)
    }
  }
  return out
}

function extractPathsFromArgs(args) {
  const out = []
  if (!args || typeof args !== 'object') return out
  for (const key of PATH_ARG_KEYS) {
    const val = args[key]
    if (typeof val === 'string' && val.trim()) {
      out.push(val.trim())
    }
  }
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) {
      if (typeof p === 'string' && p.trim()) out.push(p.trim())
    }
  }
  if (Array.isArray(args.files)) {
    for (const item of args.files) {
      if (typeof item === 'string' && item.trim()) out.push(item.trim())
      else if (item && typeof item === 'object' && typeof item.path === 'string' && item.path.trim()) {
        out.push(item.path.trim())
      }
    }
  }
  return out
}

function extractSubagentPaths(args) {
  const set = new Set()
  for (const p of extractPathsFromArgs(args)) set.add(p)
  if (typeof args?.description === 'string') {
    for (const p of extractPathsFromText(args.description)) set.add(p)
  }
  if (typeof args?.prompt === 'string') {
    for (const p of extractPathsFromText(args.prompt)) set.add(p)
  }
  return Array.from(set)
}

function inferSubagentAccess(args) {
  if (args?.access === 'read' || args?.access === 'write') return args.access
  const text = [args?.description, args?.prompt].filter((s) => typeof s === 'string').join(' ')
  if (!text) return 'read'
  if (READ_ONLY_INTENT_RE.test(text)) return 'read'
  if (WRITE_INTENT_RE.test(text)) return 'write'
  return 'read'
}

function extractTextFromBlocks(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const b of blocks) {
    if (typeof b === 'string') parts.push(b)
    else if (b && typeof b === 'object') {
      if (typeof b.text === 'string') parts.push(b.text)
      else if (typeof b.content === 'string') parts.push(b.content)
    }
  }
  return parts.join('\n')
}

function matchesAnyPattern(text, patterns) {
  if (!text || !Array.isArray(patterns)) return false
  for (const re of patterns) {
    if (re instanceof RegExp) {
      re.lastIndex = 0
      if (re.test(text)) return true
    }
  }
  return false
}

function inferChunkClassification({ toolName = '', source = '', text = '', args = null }) {
  const lowerTool = String(toolName || '').toLowerCase()

  let kind = 'tool_output'
  if (lowerTool === 'read' || lowerTool === 'read_image') {
    kind = 'file_read'
  } else if (lowerTool === 'grep' || lowerTool === 'glob') {
    kind = 'search_result'
  } else if (/^(?:pwsh|bash|shell|exec|terminal|command|run_code)$/.test(lowerTool)) {
    kind = 'command_output'
  } else if (/^(?:subagent|subagent_fork|summon_expert|summon_experts|summon_expert_team)$/.test(lowerTool)) {
    kind = 'subagent_result'
  }

  let access = 'read'
  if (lowerTool === 'run_code') {
    access = classifyRunCodeAccess(typeof args?.code === 'string' ? args.code : '')
  } else if (/^(?:write|edit|apply_patch|fs_write|fs_edit|rm|delete|move|mv)$/.test(lowerTool)) {
    access = 'write'
  } else if (DEFAULT_POLICY.destructiveTools.includes(lowerTool) && lowerTool !== 'pwsh' && lowerTool !== 'bash') {
    access = 'write'
  }

  let sensitivity = 'internal'
  const headSample = text.slice(0, 4000)
  if (
    matchesAnyPattern(source, DEFAULT_POLICY.secretPathPatterns) ||
    SECRET_CONTENT_RE.test(headSample)
  ) {
    sensitivity = 'secret'
  } else if (matchesAnyPattern(source, DEFAULT_POLICY.sensitivePathPatterns)) {
    sensitivity = 'sensitive'
  } else if (PUBLIC_SOURCE_RE.test(source)) {
    sensitivity = 'public'
  }

  return { kind, access, sensitivity }
}

// Gate denials are already recorded as structured gate events in the JSONL
// telemetry. Ingesting the human-readable denial text back into the chunk
// ledger feeds a stream of "Error: JEVHarness blocked ..." / "Error: JeV
// permissions=..." chunks into the next JeV snapshot, which biases JeV toward
// ever-stricter permissions and locks the session down (gate-error feedback
// self-lock). Suppress those specific error results from business context.
const GATE_DENIAL_SIGNATURE_RE =
  /JEVHarness (?:blocked|blocks|inspected|refused)|JeV (?:permissions|security)=|blocked by (?:excludedVendors|JEVHarness)|requires first-party frontier|requires a vetted provider/i
const GATE_DENIAL_ERROR_RE = /(?:^|[\s:：(])(?:Error|ToolCallError|failed|exception)\b/i

function isGateDenialFeedback(text, data) {
  if (typeof text !== 'string' || !text.trim()) return false
  // Only short denial results qualify; large tool outputs (e.g. reading the
  // plugin's own source, which quotes these phrases) must still be ingested.
  if (text.length > 2000) return false
  const head = text.slice(0, 300)
  if (!GATE_DENIAL_SIGNATURE_RE.test(head)) return false
  return (
    Boolean(data && (data.isError === true || data.is_error === true || data.error)) ||
    GATE_DENIAL_ERROR_RE.test(head) ||
    /^\s*(?:JEVHarness|JeV)\b/.test(head)
  )
}

function parseEnvironmentFromBase(base, state) {
  const texts = []
  if (Array.isArray(base?.sections)) {
    for (const s of base.sections) {
      if (s && typeof s.text === 'string') texts.push(s.text)
    }
  }
  if (Array.isArray(base?.contexts)) {
    for (const c of base.contexts) {
      if (c && typeof c.text === 'string') texts.push(c.text)
    }
  }

  const combined = texts.join('\n')
  if (!combined) return

  const cwdMatch = CWD_LINE_RE.exec(combined)
  if (cwdMatch) {
    const rawCwd = cwdMatch[1] || cwdMatch[2] || cwdMatch[3] || ''
    const parsedCwd = unescapePathMatch(rawCwd)
    if (parsedCwd) state.cwd = parsedCwd
  }

  const policyMatch = FILE_POLICY_LINE_RE.exec(combined)
  if (policyMatch && policyMatch[1]) {
    state.filePolicy = policyMatch[1].trim()
  }

  if (APPROVAL_DISABLED_RE.test(combined)) {
    state.approvalDisabled = true
  } else if (/Approval prompts are enabled/i.test(combined)) {
    state.approvalDisabled = false
  }

  state.taskScope = DEPLOY_GOAL_RE.test(state.goal || '') ? 'deploy' : 'default'

  const rules = []
  if (state.filePolicy) rules.push(state.filePolicy)
  rules.push(state.approvalDisabled ? 'approval prompts disabled' : 'approval prompts enabled')
  rules.push('external content untrusted')
  if (state.taskScope === 'deploy') rules.push('taskScope=deploy')
  state.rules = rules
}

function computeDecisionSignature(parsed) {
  const vis = parsed?.context_visibility?.level || '?'
  const cache = parsed?.cache_prefix?.action || '?'
  const routing = parsed?.routing?.value || '?'
  const tools = parsed?.tools?.value || '?'
  const perm = parsed?.permissions?.action || '?'
  const sec = parsed?.security?.level || '?'
  return [vis, cache, routing, tools, perm, sec].join('|')
}

function renderStableDecision(parsed) {
  const vis = parsed?.context_visibility
  const cache = parsed?.cache_prefix
  const route = parsed?.routing
  const toolStrat = parsed?.tools
  const perm = parsed?.permissions
  const sec = parsed?.security

  const visStr = vis ? `${vis.level}(${bucketConfidence(vis.confidence)})` : '?'
  const cacheStr = cache ? `${cache.action}(${bucketConfidence(cache.confidence)})` : '?'
  const routeStr = route ? `${route.value}(${bucketConfidence(route.confidence)})` : '?'
  const toolsStr = toolStrat ? `${toolStrat.value}(${bucketConfidence(toolStrat.confidence)})` : '?'
  const permStr = perm ? `${perm.action}(${bucketConfidence(perm.confidence)})` : '?'
  const secStr = sec ? `${sec.level}(${bucketConfidence(sec.confidence)})` : '?'

  const directives = [
    `keep only chunks the goal needs (visibility=${vis ? vis.level : '?'})`,
    `prefer ${toolStrat ? toolStrat.value : 'targeted'} over dumping whole files`,
    'reuse prefix only if cache=reuse',
  ]

  if (sec && typeof sec.index === 'number' && sec.index >= 2) {
    directives.push(
      `security=${sec.level}: enforce first-party frontier only; do not print or route tokens, ids, cookies, or secrets`
    )
  } else if (route && (route.value === 'cheap' || route.value === 'background')) {
    const trustNote = sec?.level === 'public'
      ? 'Table IV open trust (public): safe to offload small-context/read-only subtasks to a cheap or background subagent'
      : 'Table IV standard trust (internal): offload only small-context/read-only subtasks to a vetted provider; avoid rebuilding large frontier context'
    directives.push(trustNote)
  }

  return [
    `[JeV harness · per-step decision · ${parsed?.model || 'jev'}]`,
    `context_visibility=${visStr}; cache=${cacheStr}; routing=${routeStr}; tools=${toolsStr}; permissions=${permStr}; security=${secStr}`,
    `Apply this step: ${directives.join('; ')}.`,
  ].join('\n')
}

function createNoopTelemetry() {
  return {
    async recordDecision() {},
    async recordGateEvent() {},
    async flush() {},
    async clearSession() {},
  }
}

function createTelemetryInstance(cfg) {
  if (cfg.telemetryLogger && typeof cfg.telemetryLogger === 'object') {
    return cfg.telemetryLogger
  }
  if (cfg.telemetryEnabled === false) {
    return createNoopTelemetry()
  }
  const opts = {}
  if (cfg.telemetryDir) opts.dir = cfg.telemetryDir
  if (typeof cfg.writeLegacyMarkdown === 'boolean') {
    opts.writeLegacyMarkdown = cfg.writeLegacyMarkdown
  }
  return createTelemetryLogger(opts)
}

function createSessionState(sessionId) {
  return {
    sessionId,
    isJev: false,
    nonJevConfirmed: false,
    goal: '',
    cwd: '',
    filePolicy: '',
    approvalDisabled: false,
    taskScope: 'default',
    rules: [],
    activePaths: new Set(),
    recentTools: [],
    steps: 0,
    turns: 0,
    toolResults: 0,
    lastToolChars: 0,
    decision: null,
    decisionAt: 0,
    lastSignature: '',
    frozenDecisionText: '',
    inFlightSubgoals: new Map(),
    // Per-chunk credited token savings (dedupe so the cumulative "saved" total
    // never double-counts the same chunk across steps). { saving, counted }
    savedByChunk: new Map(),
  }
}

export function apply(ctx, config = {}) {
  const cfg = {
    enabled: config.enabled !== false,
    model: typeof config.model === 'string' && config.model.trim() ? config.model.trim() : DEFAULT_MODEL,
    timeoutMs: Number.isInteger(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS,
    throttleMs: Number.isInteger(config.throttleMs) && config.throttleMs >= 0 ? config.throttleMs : DEFAULT_THROTTLE_MS,
    decisionTtlMs: Number.isInteger(config.decisionTtlMs) && config.decisionTtlMs > 0
      ? config.decisionTtlMs
      : DEFAULT_DECISION_TTL_MS,
    conditionalRulesMaxBytes:
      Number.isInteger(config.conditionalRulesMaxBytes) && config.conditionalRulesMaxBytes > 0
        ? config.conditionalRulesMaxBytes
        : DEFAULT_CONDITIONAL_RULES_MAX_BYTES,
    chunkDigestMaxChars:
      Number.isInteger(config.chunkDigestMaxChars) && config.chunkDigestMaxChars > 0
        ? config.chunkDigestMaxChars
        : DEFAULT_CHUNK_DIGEST_MAX_CHARS,
    subgoalInFlightTtlMs:
      Number.isInteger(config.subgoalInFlightTtlMs) && config.subgoalInFlightTtlMs >= 0
        ? config.subgoalInFlightTtlMs
        : DEFAULT_SUBGOAL_INFLIGHT_TTL_MS,
    maxChunksPerSession: config.maxChunksPerSession,
    chunkPersistDir: config.chunkPersistDir,
    policy: config.policy || null,
    fetchImpl: config.fetchImpl,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    telemetryDir: config.telemetryDir,
    writeLegacyMarkdown: config.writeLegacyMarkdown,
    telemetryEnabled: config.telemetryEnabled !== false,
    telemetryLogger: config.telemetryLogger,
    autoRepairLegacyLogs: config.autoRepairLegacyLogs !== false,
    autoRepairSkipActiveMs:
      Number.isInteger(config.autoRepairSkipActiveMs) && config.autoRepairSkipActiveMs >= 0
        ? config.autoRepairSkipActiveMs
        : 15000,
    autoRepairMaxFiles:
      Number.isInteger(config.autoRepairMaxFiles) && config.autoRepairMaxFiles > 0
        ? config.autoRepairMaxFiles
        : 500,
  }

  /** @type {Map<string, ReturnType<typeof createSessionState>>} */
  const sessions = new Map()
  const chunkStore = createChunkStore({
    maxChunksPerSession: cfg.maxChunksPerSession,
    persistDir: cfg.chunkPersistDir,
  })
  const subgoalTracker = createSubgoalTracker({ inFlightTtlMs: cfg.subgoalInFlightTtlMs })
  const telemetry = createTelemetryInstance(cfg)
  const liveBus = createLiveBus({
    maxEvents: Number.isInteger(config.liveMaxEvents) && config.liveMaxEvents > 0 ? config.liveMaxEvents : undefined,
    activeTtlMs: Number.isInteger(config.liveActiveTtlMs) && config.liveActiveTtlMs > 0 ? config.liveActiveTtlMs : undefined,
  })

  // --- UI self-check diagnostics -------------------------------------------
  // Writes JSON markers into the telemetry dir so we can tell whether the web
  // client bundle was actually collected and executed:
  //   _ui-diag.json   <- this host plugin (always loads) : is our module in the
  //                      web client module graph?
  //   _ui-root.json   <- preset host half (only if the self-insert row loads it)
  //   _client-hello.json <- browser client called the channel (client executed)
  const diagDir = typeof cfg.telemetryDir === 'string' && cfg.telemetryDir.trim()
    ? cfg.telemetryDir
    : join(homedir(), '.dsh', 'jev-decisions')
  function appendJev(session, type, data) {
    // Persist as a host plugin record (ignorable:true, 'plugin:' namespace) so a
    // reopened session never rejects the log. Async + fully fail-open: if the
    // host module is unavailable we drop the event rather than corrupt history.
    const pluginType = toPluginRecordType(type)
    const sid = session && (session.id || session.sessionId)
    const payload = sid ? Object.assign({}, data, { sessionId: sid }) : data
    loadHostSessionModule().then((mod) => {
      if (!mod || typeof mod.appendPluginRecord !== 'function') {
        writeDiag('_ui-append.json', { ok: false, reason: 'no host appendPluginRecord', type: pluginType })
        return
      }
      const sameInstance = !mod.Session || (session instanceof mod.Session)
      try {
        mod.appendPluginRecord(session, pluginType, payload)
        writeDiag('_ui-append.json', { ok: true, type: pluginType, sameInstance, at: new Date().toISOString() })
      } catch (e) {
        // Includes the "wrong module copy" case: nothing is written, log stays intact.
        writeDiag('_ui-append.json', { ok: false, error: String(e && e.message ? e.message : e), sameInstance, type: pluginType })
      }
    }).catch((e) => {
      writeDiag('_ui-append.json', { ok: false, error: String(e && e.message ? e.message : e), type: pluginType })
    })
  }
  function writeDiag(name, obj) {
    try {
      mkdirSync(diagDir, { recursive: true })
      writeFileSync(join(diagDir, name), JSON.stringify({ ts: new Date().toISOString(), ...obj }, null, 2), 'utf8')
    } catch {
      /* diagnostics are fail-open */
    }
  }
  try {
    const cm = typeof ctx?.get === 'function' ? ctx.get('clientModules') : null
    const g = cm && typeof cm.graph === 'function' ? cm.graph() : null
    let ids = []
    if (g) {
      if (Array.isArray(g.entries)) ids = g.entries.map((e) => (e && (e.id || e.name || e.key)) || '').filter(Boolean)
      else if (Array.isArray(g)) ids = g.map((e) => (e && (e.id || e.name)) || '').filter(Boolean)
    }
    const gs = g ? JSON.stringify(g) : ''
    writeDiag('_ui-diag.json', {
      source: 'jev-harness-loop',
      clientModulesAvailable: !!cm,
      graphAvailable: !!g,
      entryCount: ids.length,
      containsPreset: /@local\/dsh-jevharness-preset/.test(gs),
      containsAnyJev: /jev/i.test(gs),
      sampleIds: ids.slice(0, 300),
    })
  } catch (err) {
    writeDiag('_ui-diag.json', { source: 'jev-harness-loop', error: String(err?.message || err) })
  }

  function stateOf(sessionId) {
    let st = sessions.get(sessionId)
    if (!st) {
      st = createSessionState(sessionId)
      sessions.set(sessionId, st)
    }
    return st
  }

  // ---------------------------------------------------------------------------
  // Register read-only JEV tools (safe when ctx.tools is absent)
  // ---------------------------------------------------------------------------
  if (ctx?.tools && typeof ctx.tools.register === 'function') {
    ctx.tools.register({
      name: 'jev_chunk_read',
      description:
        'Restore and read any stored context chunk (including chunks hidden or compressed by the visibility ladder) at short_summary, long_summary, or full level with optional offset/limit paging.',
      parameters: {
        type: 'object',
        properties: {
          chunk_id: {
            type: 'string',
            description: 'Chunk identifier from the [Chunk Index] digest (e.g. "c1").',
          },
          level: {
            type: 'string',
            enum: ['short_summary', 'long_summary', 'full'],
            description: 'Desired detail level. Defaults to "full".',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            description: 'Character offset into the selected representation. Defaults to 0.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum characters to return. Defaults to 4000.',
          },
          session_id: {
            type: 'string',
            description: 'Optional session id override; defaults to the active session.',
          },
        },
        required: ['chunk_id'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const chunkId = typeof args?.chunk_id === 'string' && args.chunk_id.trim()
          ? args.chunk_id.trim()
          : (typeof args?.id === 'string' ? args.id.trim() : '')
        if (!chunkId) {
          return { error: 'chunk_id is required' }
        }
        const sessionId =
          (typeof args?.session_id === 'string' && args.session_id.trim()) ||
          resolveSessionId(exec, 'exec')
        if (!sessionId) {
          return { error: 'Unable to resolve session_id for jev_chunk_read' }
        }
        try {
          const chunk = chunkStore.readChunk(sessionId, chunkId, {
            level: args?.level || 'full',
            offset: args?.offset,
            limit: args?.limit,
          })
          if (!chunk) {
            return { error: `Chunk "${chunkId}" not found in session "${sessionId}"` }
          }
          return chunk
        } catch (err) {
          return { error: String(err?.message || err) }
        }
      },
    })

    ctx.tools.register({
      name: 'jev_retrieval_pack',
      description:
        'Export a read-only shared retrieval pack of scored session chunks filtered by max_sensitivity (public/internal/sensitive) so subagents and background tasks can reuse one retrieval pass.',
      parameters: {
        type: 'object',
        properties: {
          max_sensitivity: {
            type: 'string',
            enum: ['public', 'internal', 'sensitive'],
            description: 'Maximum chunk sensitivity to include (never exports secret). Defaults to "internal".',
          },
          max_chars: {
            type: 'integer',
            minimum: 1,
            description: 'Character budget for the rendered pack. Defaults to 6000.',
          },
          session_id: {
            type: 'string',
            description: 'Optional session id override; defaults to the active session.',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const sessionId =
          (typeof args?.session_id === 'string' && args.session_id.trim()) ||
          resolveSessionId(exec, 'exec')
        if (!sessionId) {
          return { error: 'Unable to resolve session_id for jev_retrieval_pack' }
        }
        const maxSens = args?.max_sensitivity || 'internal'
        if (maxSens === 'secret') {
          return { error: 'jev_retrieval_pack refuses max_sensitivity="secret"' }
        }
        try {
          return chunkStore.exportRetrievalPack(sessionId, {
            maxSensitivity: maxSens,
            maxChars: args?.max_chars,
          })
        } catch (err) {
          return { error: String(err?.message || err) }
        }
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Live UI projection channel (host -> client, read-only, zero prompt cost).
  // Registered through reactive inject so plugin load order never matters, plus
  // an HTTP hello route and a deferred client-module-graph probe for diagnostics.
  // ---------------------------------------------------------------------------
  function registerLiveChannel(connection) {
    if (!connection) return
    try {
      if (connection.rpc && typeof connection.rpc.handle === 'function') {
        const liveHandler = async (endpoint, payload) => {
          try {
            if (endpoint === 'hello') {
              writeDiag('_client-hello.json', { source: 'rpc', payload: payload && typeof payload === 'object' ? payload : {} })
              return { ok: true, value: { ack: true } }
            }
            if (endpoint === 'probe') return { ok: true, value: liveBus.probe() }
            const args = payload && typeof payload === 'object' ? payload : {}
            const sid = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
            if (!sid) return { ok: false, error: { code: 'bad-request', message: 'sessionId is required' } }
            if (endpoint === 'since') return { ok: true, value: liveBus.since(sid, typeof args.cursor === 'number' ? args.cursor : -1) }
            if (endpoint === 'snapshot') return { ok: true, value: liveBus.since(sid, -1) }
            return { ok: false, error: { code: 'bad-request', message: 'unknown endpoint: ' + endpoint } }
          } catch (err) {
            return { ok: false, error: { code: 'internal', message: String(err && err.message ? err.message : err) } }
          }
        }
        const disposeLive = connection.rpc.handle(JEV_LIVE_CHANNEL, liveHandler)
        writeDiag('_ui-channel.json', { registered: true })
        if (typeof ctx.effect === 'function' && typeof disposeLive === 'function') {
          ctx.effect(() => disposeLive, 'jev-harness: live channel')
        }
      }
    } catch (err) {
      writeDiag('_ui-channel.json', { registered: false, error: String(err && err.message ? err.message : err) })
    }
    try {
      if (connection.fetch && typeof connection.fetch.register === 'function') {
        const helloRoute = {
          path: '/api/jev-harness/hello',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body = {}
            try { body = await request.json() } catch (e) { body = {} }
            writeDiag('_client-hello.json', { source: 'http', payload: body })
            return Response.json({ ok: true })
          },
        }
        const liveRoute = {
          path: '/api/jev-harness/live',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body = {}
            try { body = await request.json() } catch (e) { body = {} }
            const endpoint = body && body.endpoint
            if (endpoint === 'probe') return Response.json({ ok: true, value: liveBus.probe() })
            const sid = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            if (!sid) return Response.json({ ok: false, error: { message: 'sessionId is required' } })
            const cursor = typeof body.cursor === 'number' ? body.cursor : -1
            if (endpoint === 'since') return Response.json({ ok: true, value: liveBus.since(sid, cursor) })
            if (endpoint === 'snapshot') return Response.json({ ok: true, value: liveBus.since(sid, -1) })
            return Response.json({ ok: false, error: { message: 'unknown endpoint: ' + endpoint } })
          },
        }
        const d1 = connection.fetch.register(helloRoute)
        const d2 = connection.fetch.register(liveRoute)
        writeDiag('_ui-route.json', { registered: true, routes: ['/api/jev-harness/hello', '/api/jev-harness/live'] })
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => { try { if (d1) d1() } catch (e) { /* ignore */ } try { if (d2) d2() } catch (e) { /* ignore */ } }, 'jev-harness: live routes')
        }
      }
    } catch (err) {
      writeDiag('_ui-route.json', { registered: false, error: String(err && err.message ? err.message : err) })
    }
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['connection'], (inner) => {
        try { registerLiveChannel(inner && inner.connection) } catch (e) { /* fail-open */ }
      })
    } else {
      registerLiveChannel(typeof ctx?.get === 'function' ? ctx.get('connection') : null)
    }
  } catch (e) { /* fail-open */ }

  // Deferred client-module-graph probe (service may register after this plugin).
  function probeClientGraph() {
    try {
      const cm = typeof ctx?.get === 'function' ? ctx.get('clientModules') : null
      const g = cm && typeof cm.graph === 'function' ? cm.graph() : null
      if (!g) {
        writeDiag('_ui-graph2.json', { source: 'deferred', graphAvailable: false, clientModulesAvailable: !!cm })
        return
      }
      const gs = JSON.stringify(g)
      let ids = []
      if (Array.isArray(g.entries)) ids = g.entries.map((e) => (e && (e.id || e.name || e.key)) || '').filter(Boolean)
      writeDiag('_ui-graph2.json', {
        source: 'deferred',
        graphAvailable: true,
        entryCount: ids.length,
        containsPreset: /@local\/dsh-jevharness-preset/.test(gs),
        containsAnyJev: /jev/i.test(gs),
        sampleIds: ids.slice(0, 300),
      })
    } catch (e) {
      writeDiag('_ui-graph2.json', { source: 'deferred', error: String(e && e.message ? e.message : e) })
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['clientModules'], () => { try { probeClientGraph() } catch (e) { /* ignore */ } })
    for (const ms of [3000, 8000]) { try { const t = setTimeout(probeClientGraph, ms); if (t && typeof t.unref === 'function') t.unref() } catch (e) { /* ignore */ } }
  } catch (e) { /* fail-open */ }

  // ---------------------------------------------------------------------------
  // Event 1: session/event — strict per-session ledger & typed chunk ingestion
  // ---------------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    try {
      if (!cfg.enabled || !event) return
      const sessionId = resolveSessionId(session, 'session')
      if (!sessionId) return

      const state = stateOf(sessionId)
      const type = event.type
      const data = event.data || {}

      if (type === 'user/message') {
        const text = extractTextFromBlocks(data.content).trim()
        if (text) {
          state.goal = text.slice(0, 400)
          state.taskScope = DEPLOY_GOAL_RE.test(state.goal) ? 'deploy' : 'default'
          for (const p of extractPathsFromText(text)) {
            addActivePath(state, p)
          }
        }
      } else if (type === 'tool/result') {
        state.toolResults += 1
        const text = extractTextFromBlocks(
          data.message?.content ?? data.content ?? data.output ?? data.result ?? ''
        )
        state.lastToolChars = text.length

        const toolName = String(
          data.name || data.toolName || data.tool || data.message?.name || ''
        ).trim()
        const toolArgs = data.args || data.arguments || data.input || null
        const source = String(
          data.source ||
            data.path ||
            data.file_path ||
            toolArgs?.file_path ||
            toolArgs?.path ||
            toolName ||
            'tool_result'
        ).trim()

        if (toolName) pushRecentTool(state, toolName)

        // Gate-denial feedback (a blocked sensitive-path read, an out-of-repo
        // write, ...) must not pollute the active-path set. Adding the rejected
        // path here would leave it lingering as if it were a live working path
        // and skew the next JeV snapshot. Skip path capture for denial feedback;
        // the tool name is still recorded above.
        const gateDenied = text.length > 0 && isGateDenialFeedback(text, data)
        if (!gateDenied) {
          if (toolArgs) {
            for (const p of extractPathsFromArgs(toolArgs)) addActivePath(state, p)
          }
          if (source && source !== toolName && source !== 'tool_result') {
            addActivePath(state, source)
          }
        }

        if (text.length > 0 && !state.nonJevConfirmed && !gateDenied) {
          const classified = inferChunkClassification({
            toolName,
            source,
            text,
            args: toolArgs,
          })
          chunkStore.addChunk(sessionId, {
            kind: classified.kind,
            access: classified.access,
            sensitivity: classified.sensitivity,
            source,
            fullText: text,
            turn: state.turns,
            step: state.steps,
          })
        }
      } else if (type === 'step/end') {
        state.steps += 1
        if (state.isJev) {
          try { liveBus.push(sessionId, { kind: 'step', turn: state.turns, step: state.steps }) } catch { /* fail-open */ }
        }
      } else if (type === 'turn/start') {
        // Prefer the host's authoritative turn index (turn/start carries data.turn).
        // Incrementing a process-local counter resets to 1 after every restart,
        // which relabels later turns as turn 1 and makes the UI collapse them.
        const authoritativeTurn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? data.turn : null
        state.turns = authoritativeTurn !== null ? authoritativeTurn : state.turns + 1
        if (state.isJev) {
          try {
            liveBus.markJev(sessionId)
            liveBus.setTurns(sessionId, state.turns)
            liveBus.push(sessionId, { kind: 'turn', turn: state.turns, step: state.steps })
          } catch { /* fail-open */ }
        }
      } else if (type === 'turn/end') {
        // Turn-end receipt: standard turn/end reaches the client; the log-only
        // jev/receipt event is a guaranteed fallback on the same path as decisions.
        if (state.isJev) {
          try { liveBus.push(sessionId, { kind: 'turn/end', turn: state.turns, step: state.steps }) } catch { /* fail-open */ }
          try { appendJev(session, 'jev/receipt', { turn: state.turns, step: state.steps }) } catch { /* fail-open */ }
        }
      }
    } catch {
      /* fail-open: never break the durable event feed */
    }
  })

  // ---------------------------------------------------------------------------
  // Event 2: tools/post-execute — fail-open tool & subgoal lifecycle tracking
  // ---------------------------------------------------------------------------
  try {
    ctx.on('tools/post-execute', async (exec, secondArg, thirdArg) => {
      const nextFn =
        typeof thirdArg === 'function'
          ? thirdArg
          : (typeof secondArg === 'function' ? secondArg : null)
      const resultObj = typeof secondArg === 'function' ? undefined : secondArg

      const runAfter = (overrideResult) => {
        try {
          if (!cfg.enabled || !exec) return
          const effectiveResult = overrideResult !== undefined ? overrideResult : resultObj
          const sessionId = resolveSessionId(exec, 'exec')
          if (!sessionId) return
          const state = sessions.get(sessionId)
          if (!state || !state.isJev) return

          const toolName = String(exec.name || exec.definition?.name || '').trim()
          const args = exec.args || exec.arguments || {}

          if (toolName) pushRecentTool(state, toolName)
          for (const p of extractPathsFromArgs(args)) {
            addActivePath(state, p)
          }

          if (toolName.toLowerCase() === 'subagent') {
            const lookupKey =
              (typeof exec.callId === 'string' && exec.callId) ||
              (typeof exec.id === 'string' && exec.id) ||
              (typeof args.name === 'string' && args.name) ||
              (typeof args.description === 'string' && args.description.trim()) ||
              ''
            let subgoalId = lookupKey ? state.inFlightSubgoals.get(lookupKey) : null
            if (!subgoalId && state.inFlightSubgoals.size > 0) {
              // Match by description fallback
              const descKey = typeof args.description === 'string' ? args.description.trim() : ''
              if (descKey && state.inFlightSubgoals.has(descKey)) {
                subgoalId = state.inFlightSubgoals.get(descKey)
              }
            }
            const isAsyncActivation = Boolean(
              effectiveResult && (effectiveResult.kind === 'activation' || effectiveResult.value?.kind === 'activation')
            )
            if (subgoalId && !isAsyncActivation) {
              const failed = Boolean(effectiveResult && (effectiveResult.error || effectiveResult.isError))
              const summaryText =
                typeof effectiveResult === 'string'
                  ? effectiveResult.slice(0, 300)
                  : (effectiveResult && typeof effectiveResult.text === 'string'
                    ? effectiveResult.text.slice(0, 300)
                    : '')
              subgoalTracker.completeSubgoal(sessionId, subgoalId, {
                status: failed ? 'failed' : 'completed',
                summary: summaryText,
              })
              for (const [k, v] of state.inFlightSubgoals.entries()) {
                if (v === subgoalId) state.inFlightSubgoals.delete(k)
              }
            }
          }
        } catch {
          /* fail-open */
        }
      }

      if (nextFn) {
        let res
        try {
          res = await nextFn()
        } catch (err) {
          // A tool error (报错) must not strand the subgoal as in_flight forever,
          // otherwise every later identical dispatch self-locks as a duplicate or
          // lock conflict. Always release the lifecycle on the error path.
          runAfter({ error: err, isError: true })
          throw err
        }
        runAfter(res)
        return res
      }
      runAfter()
      return undefined
    })
  } catch {
    /* host may not support tools/post-execute; fail-open */
  }

  // ---------------------------------------------------------------------------
  // Event 3: system-prompt/assemble — per-step JeV decision, KV-cache freeze,
  // conditional rules (§VIII), and explicit chunk index (§V)
  // ---------------------------------------------------------------------------
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const base = await next()
    if (!cfg.enabled) return base

    // Strict persona gate: never touch, mark, query, or log non-JEV sessions.
    const sections = Array.isArray(base?.sections) ? base.sections : []
    const isJev = sections.some(
      (s) => s && typeof s.text === 'string' && JEV_MARKERS.some((m) => s.text.includes(m))
    )
    if (!isJev) {
      if (context && context.toolSet !== undefined) {
        const nonJevSid = resolveSessionId(context, 'context')
        if (nonJevSid) {
          const st = sessions.get(nonJevSid)
          if (st && !st.isJev) {
            st.nonJevConfirmed = true
            chunkStore.clearSession(nonJevSid)
          }
        }
      }
      return base
    }

    // Skip inspection / dry-run assemblies without a live tool set.
    if (!context || context.toolSet === undefined) return base

    const sessionId = resolveSessionId(context, 'context')
    if (!sessionId) return base

    try {
      const state = stateOf(sessionId)
      state.isJev = true
      parseEnvironmentFromBase(base, state)

      const chunkMeta = chunkStore.listMetadata(sessionId, { limit: 12 })
      const now = Date.now()
      const shouldQuery =
        !state.decision ||
        cfg.throttleMs === 0 ||
        now - state.decisionAt > cfg.throttleMs

      let freshCallResult = null
      if (shouldQuery) {
        const snapshot = {
          goal: state.goal || 'continue the current coding task',
          cwd: state.cwd || undefined,
          taskScope: state.taskScope,
          progress: {
            steps: state.steps,
            turns: state.turns,
            toolResults: state.toolResults,
            lastToolChars: state.lastToolChars,
          },
          activePaths: Array.from(state.activePaths),
          recentTools: [...state.recentTools],
          rules: state.rules.length > 0 ? [...state.rules] : ['external content untrusted'],
          chunks: chunkMeta.map((c) => ({
            id: c.id,
            kind: c.kind,
            access: c.access,
            sensitivity: c.sensitivity,
            source: c.source,
            lines: c.lines,
            chars: c.chars,
            visibility: c.visibility,
            shortSummary: c.shortSummary,
          })),
        }

        const questions = buildStepQuestions(chunkMeta.map((c) => c.id))
        const res = await callSystemOne({
          model: cfg.model,
          state: snapshot,
          questions,
          timeoutMs: cfg.timeoutMs,
          signal: context.signal,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          fetchImpl: cfg.fetchImpl,
        })

        if (res && res.ok) {
          freshCallResult = res
          const parsed = parseDecision(res)
          state.decision = parsed
          state.decisionAt = Date.now()

          // Apply per-chunk visibility scores to chunkStore
          if (parsed.chunk_visibility && Object.keys(parsed.chunk_visibility).length > 0) {
            const visMap = {}
            for (const [cid, v] of Object.entries(parsed.chunk_visibility)) {
              if (v && v.level) visMap[cid] = v.level
            }
            if (Object.keys(visMap).length > 0) {
              chunkStore.applyVisibility(sessionId, visMap)
            }
          }
        }
      }

      const addedContexts = []

      // §VIII Condition-bound rules — evaluate before telemetry so rule count is recorded
      let condResult = null
      if (state.cwd) {
        try {
          condResult = loadConditionalRules({
            cwd: state.cwd,
            goal: state.goal,
            activePaths: Array.from(state.activePaths),
            recentTools: state.recentTools,
            maxBytes: cfg.conditionalRulesMaxBytes,
          })
        } catch {
          /* conditional rules are fail-open */
        }
      }

      if (state.decision) {
        const parsed = state.decision
        const sig = computeDecisionSignature(parsed)
        const reuseRequested = parsed.cache_prefix?.reuse === true
        let decisionText
        let cacheFrozen = false

        if (reuseRequested && sig === state.lastSignature && state.frozenDecisionText) {
          // Byte-for-byte identical reuse for KV-cache stability
          decisionText = state.frozenDecisionText
          cacheFrozen = true
        } else {
          decisionText = renderStableDecision(parsed)
          state.lastSignature = sig
          state.frozenDecisionText = decisionText
        }

        // Note: context_visibility === 'hide' hides retrieved chunk content,
        // never the decision header itself.
        addedContexts.push({ name: 'jev-harness', text: decisionText })

        if (freshCallResult) {
          telemetry.recordDecision(sessionId, {
            ts: new Date().toISOString(),
            model: parsed.model || cfg.model,
            decisionLine: (decisionText.split('\n')[1] || decisionText).trim(),
            parsed,
            latencyMs: freshCallResult.latencyMs ?? parsed.latencyMs ?? null,
            usage: parsed.usage || null,
            chunkCount: chunkMeta.length,
            conditionalRulesCount: Array.isArray(condResult?.rules) ? condResult.rules.length : 0,
            cacheFrozen,
          })
        }

        // Live UI projection — same decision, pushed into the in-memory bus for
        // the client HUD / turn-tail. Read-only side channel; not in the prompt.
        // Estimate token savings from the visibility ladder (chars compressed
        // away, ~4 chars/token). Best-effort; labeled "估算" in the UI.
        // Estimate token savings from the visibility ladder (chars compressed
        // away, ~4 chars/token). Counted with a per-chunk high-water mark so the
        // SAME chunk is not credited twice across steps: the cumulative "saved"
        // total is the sum over unique chunks of their best saving (and the
        // rate denominator counts each chunk's chars once). Best-effort; the UI
        // labels it "估算".
        let savedTokens = 0
        let ledgerChars = 0
        try {
          const perChunk = parsed.chunk_visibility || {}
          const globalLvl = parsed.context_visibility?.level || 'full'
          for (const c of chunkMeta) {
            const chars = typeof c.chars === 'number' ? c.chars : 0
            if (chars <= 0) continue
            const lvl = (perChunk[c.id] && perChunk[c.id].level) || globalLvl
            const frac = lvl === 'hide' ? 0 : lvl === 'short_summary' ? 0.15 : lvl === 'long_summary' ? 0.4 : 1
            const fullSaving = (chars * (1 - frac)) / 4
            const prev = state.savedByChunk.get(c.id) || { saving: 0, counted: false }
            if (fullSaving > prev.saving) {
              savedTokens += fullSaving - prev.saving
              prev.saving = fullSaving
            }
            if (!prev.counted) {
              ledgerChars += chars
              prev.counted = true
            }
            state.savedByChunk.set(c.id, prev)
          }
        } catch {
          /* estimate is best-effort */
        }
        savedTokens = Math.round(savedTokens)
        // Phase 3 deep-decision projection: a compact per-chunk visibility ladder
        // (after this step's scoring) plus the conditional rules actually mounted.
        // No raw chunk text crosses into the UI side channel.
        let chunkLadder = []
        let ruleHits = []
        try {
          chunkLadder = chunkStore.listMetadata(sessionId, { limit: 12 }).map((c) => ({
            id: c.id,
            kind: c.kind,
            source: c.source,
            sensitivity: c.sensitivity,
            visibility: c.visibility,
            chars: c.chars,
            lines: c.lines,
          }))
        } catch { /* deep projection is fail-open */ }
        try {
          ruleHits = Array.isArray(condResult?.rules)
            ? condResult.rules.slice(0, 24).map((r) => ({
                id: r.id,
                name: r.name,
                source: r.source,
                reason: r.reason,
              }))
            : []
        } catch { /* deep projection is fail-open */ }
        try {
          liveBus.markJev(sessionId)
          liveBus.push(sessionId, {
            kind: 'decision',
            turn: state.turns,
            step: state.steps,
            model: parsed.model || cfg.model,
            lines: {
              context_visibility: parsed.context_visibility?.level ?? null,
              cache: parsed.cache_prefix?.action ?? null,
              routing: parsed.routing?.value ?? null,
              tools: parsed.tools?.value ?? null,
              permissions: parsed.permissions?.action ?? null,
              security: parsed.security?.level ?? null,
            },
            decisionLine: (decisionText.split('\n')[1] || '').trim(),
            directives: (decisionText.split('\n')[2] || '').trim(),
            latencyMs: freshCallResult?.latencyMs ?? parsed.latencyMs ?? null,
            chunkCount: chunkMeta.length,
            rulesCount: Array.isArray(condResult?.rules) ? condResult.rules.length : 0,
            cacheFrozen,
            savedTokens,
            ledgerChars,
            chunkLadder,
            ruleHits,
          })
        } catch {
          /* live projection is fail-open */
        }
        // Durable log-only event: reaches the client renderer through the
        // standard session event stream (Conversation Node). This is the
        // supported cross-process path, unlike custom /api or rpc routes.
        try {
          appendJev(context && context.agent && context.agent.session, 'jev/decision', {
            turn: state.turns,
            step: state.steps,
            model: parsed.model || cfg.model,
            lines: {
              context_visibility: parsed.context_visibility?.level ?? null,
              cache: parsed.cache_prefix?.action ?? null,
              routing: parsed.routing?.value ?? null,
              tools: parsed.tools?.value ?? null,
              permissions: parsed.permissions?.action ?? null,
              security: parsed.security?.level ?? null,
            },
            latencyMs: freshCallResult?.latencyMs ?? parsed.latencyMs ?? null,
            chunkCount: chunkMeta.length,
            rulesCount: Array.isArray(condResult?.rules) ? condResult.rules.length : 0,
            cacheFrozen,
            savedTokens,
            ledgerChars,
            chunkLadder,
            ruleHits,
          })
        } catch (e) { /* fail-open */ }
      }

      if (condResult && condResult.rendered) {
        addedContexts.push({ name: 'jev-conditional-rules', text: condResult.rendered })
      }

      // §V Explicit chunk index digest
      try {
        const digest = chunkStore.renderDigest(sessionId, {
          maxChars: cfg.chunkDigestMaxChars,
        })
        if (digest) {
          addedContexts.push({ name: 'jev-chunks', text: digest })
        }
      } catch {
        /* chunk digest is fail-open */
      }

      if (addedContexts.length === 0) return base
      return {
        ...base,
        contexts: [...(Array.isArray(base.contexts) ? base.contexts : []), ...addedContexts],
      }
    } catch {
      return base
    }
  })

  // ---------------------------------------------------------------------------
  // Event 4: tools/pre-execute — programmable permission, routing & subgoal gate
  // ---------------------------------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      if (!cfg.enabled || !exec) return next()

      const sessionId = resolveSessionId(exec, 'exec')
      if (!sessionId) return next()

      const state = sessions.get(sessionId)
      if (!state || !state.isJev) {
        // Strict isolation: never interfere with non-JEV sessions
        return next()
      }

      const toolName = String(exec.name || exec.definition?.name || '').trim()
      const args = exec.args || exec.arguments || {}

      // Fresh JeV decision (or null if expired/unavailable — deterministic rules 1-4 & 6 still apply!)
      const freshDecision =
        state.decision && Date.now() - state.decisionAt <= cfg.decisionTtlMs
          ? state.decision
          : null

      const verdict = evaluateToolGate({
        toolName,
        args,
        decision: freshDecision,
        cwd: state.cwd,
        taskScope: state.taskScope,
        approvalDisabled: state.approvalDisabled,
        policy: cfg.policy,
      })

      if (verdict.kind === 'deny' || verdict.kind === 'ask') {
        telemetry.recordGateEvent(sessionId, {
          ts: new Date().toISOString(),
          toolName,
          kind: verdict.kind,
          ruleId: verdict.ruleId,
          reason: verdict.reason,
        })
        try {
          liveBus.push(sessionId, {
            kind: 'gate',
            turn: state.turns,
            step: state.steps,
            toolName,
            verdict: verdict.kind,
            ruleId: verdict.ruleId,
            reason: verdict.reason,
          })
        } catch {
          /* live projection is fail-open */
        }
        try {
          appendJev(exec && exec.agent && exec.agent.session, 'jev/gate', {
            turn: state.turns,
            step: state.steps,
            toolName,
            verdict: verdict.kind,
            ruleId: verdict.ruleId,
            reason: verdict.reason,
          })
        } catch (e) { /* fail-open */ }
        return { kind: verdict.kind, reason: verdict.reason }
      }

      // §VI.A & §VI.B Subgoal deduplication and read/write path locking
      if (toolName.toLowerCase() === 'subagent') {
        const description = typeof args.description === 'string' ? args.description : ''
        const prompt = typeof args.prompt === 'string' ? args.prompt : ''
        const paths = extractSubagentPaths(args)
        const access = inferSubagentAccess(args)

        const dup = subgoalTracker.checkDuplicate(sessionId, {
          description,
          prompt,
          paths,
        })
        if (dup.duplicate) {
          const reason =
            `JEVHarness blocked duplicate subagent dispatch (${dup.status} subgoal ${dup.existing.id}, similarity ${dup.similarity}): reuse existing work instead of launching twice.`
          telemetry.recordGateEvent(sessionId, {
            ts: new Date().toISOString(),
            toolName,
            kind: 'deny',
            ruleId: 'subgoal-duplicate',
            reason,
          })
          return { kind: 'deny', reason }
        }

        const reg = subgoalTracker.registerSubgoal(sessionId, {
          id: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined,
          description,
          prompt,
          access,
          paths,
        })
        if (reg.conflict) {
          const holderDesc = reg.holders
            .map((h) => `${h.id}(${h.access}: ${h.conflictingPaths.join(', ')})`)
            .join('; ')
          const reason =
            `JEVHarness blocked subagent ${access} on overlapping path(s) due to concurrent lock conflict with ${holderDesc}.`
          telemetry.recordGateEvent(sessionId, {
            ts: new Date().toISOString(),
            toolName,
            kind: 'deny',
            ruleId: 'subgoal-write-lock-conflict',
            reason,
          })
          return { kind: 'deny', reason }
        }

        if (reg.registered && reg.subgoal) {
          const sgId = reg.subgoal.id
          if (typeof exec.callId === 'string' && exec.callId) {
            state.inFlightSubgoals.set(exec.callId, sgId)
          }
          if (typeof exec.id === 'string' && exec.id) {
            state.inFlightSubgoals.set(exec.id, sgId)
          }
          if (typeof args.name === 'string' && args.name.trim()) {
            state.inFlightSubgoals.set(args.name.trim(), sgId)
          }
          if (description.trim()) {
            state.inFlightSubgoals.set(description.trim(), sgId)
          }
        }
      }

      return next()
    } catch {
      return next()
    }
  })

  // ---------------------------------------------------------------------------
  // Event 5: agent/disposed — cleanup per-session state to prevent memory leaks
  // ---------------------------------------------------------------------------
  try {
    ctx.on('agent/disposed', (agentOrEvent) => {
      try {
        const sessionId = resolveSessionId(agentOrEvent, 'disposed')
        if (!sessionId) return
        sessions.delete(sessionId)
        chunkStore.clearSession(sessionId)
        subgoalTracker.clearSession(sessionId)
        telemetry.clearSession(sessionId)
        try { liveBus.clear(sessionId) } catch { /* fail-open */ }
      } catch {
        /* fail-open */
      }
    })
  } catch {
    /* host may not support agent/disposed; fail-open */
  }

  // ---------------------------------------------------------------------------
  // Self-heal: repair legacy session logs carrying bare jev/* events.
  // Older plugin versions wrote jev/decision|gate|receipt via session.append,
  // which makes the log unreadable on the next open. Re-tag them to
  // plugin:jev-harness/* (ignorable:true) so historical sessions open again.
  // Bounded, background, fail-open, and it skips files still being written.
  // ---------------------------------------------------------------------------
  if (cfg.autoRepairLegacyLogs && !process.env.NODE_TEST_CONTEXT && !process.env.JEV_DISABLE_AUTO_REPAIR) {
    const timer = setTimeout(() => {
      try {
        const reports = repairAll({ skipActiveMs: cfg.autoRepairSkipActiveMs, maxFiles: cfg.autoRepairMaxFiles })
        if (reports.length > 0) {
          writeDiag('_ui-repair.json', {
            at: new Date().toISOString(),
            repaired: reports.filter((r) => r.status === 'repaired').length,
            reports: reports.slice(0, 25),
          })
        }
      } catch (e) {
        writeDiag('_ui-repair.json', { ok: false, error: String(e && e.message ? e.message : e), at: new Date().toISOString() })
      }
    }, 3000)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
}
