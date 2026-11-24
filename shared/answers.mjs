/**
 * JEVHarness / shared/answers.mjs
 *
 * Table I ("JEV ENGINEERING FOR CODING AGENTS") question schema builders and
 * risk-aware answer parsers. Pure Node 20+ ESM, zero external dependencies.
 *
 * Key design principles from the paper:
 * - context_visibility uses `choice` (not `score`) to prevent expected-value
 *   truncation distortion, and supports batched per-chunk `chunk_vis_<id>` items.
 * - cache_prefix uses `noul` (probability of reusing prefix vs rebuilding).
 * - permissions uses tri-state `choice` (`allow | ask | deny`).
 * - security uses `score` with tail-probability risk escalation: if
 *   P(sensitive) + P(secret) >= 0.35, automatically escalate to at least sensitive.
 * - Continuous confidences are bucketed (`low | med | high`) for KV-cache stability.
 */

export const VISIBILITY_LEVELS = Object.freeze(['hide', 'short_summary', 'long_summary', 'full'])
export const SECURITY_LEVELS = Object.freeze(['public', 'internal', 'sensitive', 'secret'])
export const ROUTING_MODES = Object.freeze(['frontier', 'cheap', 'background'])
export const TOOL_STRATEGIES = Object.freeze(['targeted', 'full_read', 'search_source', 'execute_verify'])
export const PERMISSION_ACTIONS = Object.freeze(['allow', 'ask', 'deny'])

export const MAX_PER_CHUNK_QUESTIONS = 12
export const DEFAULT_SECURITY_TAIL_THRESHOLD = 0.35
export const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.25
export const DEFAULT_VISIBILITY_FALLBACK_THRESHOLD = 0.2

const VISIBILITY_CRITERIA = Object.freeze({
  hide: 'omit this context chunk for the current step without deleting it from state',
  short_summary: 'include only a terse 1-2 line summary of the chunk',
  long_summary: 'include structured key facts, symbols, or excerpts from the chunk',
  full: 'include the full verbatim chunk content for this step',
})

const SECURITY_CRITERIA = Object.freeze([
  'public',
  'internal',
  'sensitive - redact tokens and ids',
  'secret - do not expose',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function normalizeLevelName(rawName, levels) {
  if (typeof rawName !== 'string') return null
  const lower = rawName.trim().toLowerCase()
  for (const level of levels) {
    if (lower === level || lower.startsWith(level + ' ') || lower.startsWith(level + ' -')) {
      return level
    }
  }
  return null
}

/**
 * Bucket continuous confidence into coarse labels ('low' | 'med' | 'high')
 * so per-step injected headers remain KV-cache friendly without numeric jitter.
 * @param {number | null | undefined} conf
 * @returns {'low' | 'med' | 'high'}
 */
export function bucketConfidence(conf) {
  if (typeof conf !== 'number' || Number.isNaN(conf)) return 'low'
  if (conf >= 0.75) return 'high'
  if (conf >= 0.45) return 'med'
  return 'low'
}

/**
 * Build the Table I batched per-step JeV System One question set.
 * Optionally adds up to 12 per-chunk visibility questions (`chunk_vis_<id>`).
 * @param {string[]} [chunkIds=[]]
 * @returns {Record<string, object>}
 */
export function buildStepQuestions(chunkIds = []) {
  const questions = {
    context_visibility: {
      type: 'choice',
      instructions: 'What default visibility level should retrieved chunks use for this step?',
      criteria: { ...VISIBILITY_CRITERIA },
    },
    cache_prefix: {
      type: 'noul',
      instructions: 'Should this step reuse the existing cached prompt prefix rather than rebuilding it from scratch?',
    },
    routing: {
      type: 'choice',
      instructions: 'Which execution route fits this step?',
      criteria: {
        frontier: 'keep on the primary frontier model',
        cheap: 'route to a cheaper/faster model if trust policy permits',
        background: 'offload to a background task or subagent',
      },
    },
    tools: {
      type: 'choice',
      instructions: 'Which tool strategy best fits this step?',
      criteria: {
        targeted: 'targeted reads / grep then read narrow line ranges',
        full_read: 'read complete files when whole-file context is required',
        search_source: 'search the source tree and symbols before reading',
        execute_verify: 'run tests, builds, or verification commands',
      },
    },
    permissions: {
      type: 'choice',
      instructions: 'What permission posture applies to the actions this step intends to take?',
      criteria: {
        allow: 'safe to execute within workspace policy',
        ask: 'requires human confirmation before destructive or external-scope action',
        deny: 'must be blocked due to sensitive data, unsafe egress, or policy violation',
      },
    },
    security: {
      type: 'score',
      instructions: 'How sensitive is the data this step touches?',
      criteria: [...SECURITY_CRITERIA],
    },
  }

  if (Array.isArray(chunkIds) && chunkIds.length > 0) {
    const seen = new Set()
    let added = 0
    for (const rawId of chunkIds) {
      if (added >= MAX_PER_CHUNK_QUESTIONS) break
      if (rawId === null || rawId === undefined) continue
      const id = String(rawId).trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      questions['chunk_vis_' + id] = {
        type: 'choice',
        instructions: `What visibility level should chunk "${id}" have for this step?`,
        criteria: { ...VISIBILITY_CRITERIA },
      }
      added += 1
    }
  }

  return questions
}

/**
 * Normalize one raw JeV answer entry, tolerant of legacy and current shapes.
 * @param {unknown} raw
 */
export function parseAnswer(raw) {
  if (raw === null || raw === undefined) return null

  if (typeof raw === 'boolean') {
    return {
      kind: 'noul',
      value: raw ? 1 : 0,
      boolValue: raw,
      confidence: 1,
      probabilities: null,
    }
  }
  if (typeof raw === 'number' && !Number.isNaN(raw)) {
    const p = clamp01(raw)
    return {
      kind: 'noul',
      value: p,
      boolValue: p >= 0.5,
      confidence: Math.abs(p - 0.5) * 2,
      probabilities: null,
    }
  }
  if (!isPlainObject(raw)) return null

  const type = raw.type
  const probabilities = Array.isArray(raw.probabilities) || isPlainObject(raw.probabilities)
    ? raw.probabilities
    : null
  const explicitConf = typeof raw.confidence === 'number' && !Number.isNaN(raw.confidence)
    ? clamp01(raw.confidence)
    : null

  if (type === 'noul' || (type === undefined && 'noul' in raw)) {
    const rawVal = raw.noul
    if (typeof rawVal === 'boolean') {
      return {
        kind: 'noul',
        value: rawVal ? 1 : 0,
        boolValue: rawVal,
        confidence: explicitConf ?? 1,
        probabilities,
      }
    }
    const prob = typeof rawVal === 'number' && !Number.isNaN(rawVal) ? clamp01(rawVal) : 0.5
    return {
      kind: 'noul',
      value: prob,
      boolValue: prob >= 0.5,
      confidence: explicitConf ?? clamp01(Math.abs(prob - 0.5) * 2),
      probabilities,
    }
  }

  if (type === 'choice' || (type === undefined && typeof raw.choice === 'string')) {
    const choice = typeof raw.choice === 'string' ? raw.choice : null
    let conf = explicitConf
    if (conf === null && choice && isPlainObject(probabilities) && typeof probabilities[choice] === 'number') {
      conf = clamp01(probabilities[choice])
    }
    return {
      kind: 'choice',
      value: choice,
      confidence: conf,
      probabilities,
    }
  }

  if (type === 'score' || (type === undefined && typeof raw.score === 'number')) {
    const score = typeof raw.score === 'number' && !Number.isNaN(raw.score) ? raw.score : 0
    return {
      kind: 'score',
      value: score,
      confidence: explicitConf,
      probabilities,
    }
  }

  return null
}

/**
 * Parse a noul answer with a configurable probability threshold (default 0.5).
 * @param {unknown} raw
 * @param {number} [threshold=0.5]
 */
export function parseNoul(raw, threshold = 0.5) {
  const parsed = parseAnswer(raw)
  if (!parsed) return null

  if (parsed.kind === 'noul') {
    const probability = parsed.value
    const value = probability >= threshold
    const confidence = parsed.confidence
    return {
      kind: 'noul',
      value,
      probability,
      confidence,
      bucket: bucketConfidence(confidence),
      lowConfidence: typeof confidence === 'number' && confidence < DEFAULT_LOW_CONFIDENCE_THRESHOLD,
      probabilities: parsed.probabilities,
    }
  }

  // Fallback compatibility if a choice answer is passed into parseNoul
  if (parsed.kind === 'choice' && typeof parsed.value === 'string') {
    const lower = parsed.value.toLowerCase()
    const truthy = lower === 'true' || lower === 'yes' || lower === 'reuse' || lower === 'allow'
    const falsy = lower === 'false' || lower === 'no' || lower === 'rebuild' || lower === 'deny'
    if (truthy || falsy) {
      const conf = parsed.confidence
      const probability = truthy
        ? (typeof conf === 'number' ? conf : 1)
        : (typeof conf === 'number' ? clamp01(1 - conf) : 0)
      return {
        kind: 'noul',
        value: truthy,
        probability,
        confidence: conf,
        bucket: bucketConfidence(conf),
        lowConfidence: typeof conf === 'number' && conf < DEFAULT_LOW_CONFIDENCE_THRESHOLD,
        probabilities: parsed.probabilities,
      }
    }
  }

  return null
}

function normalizeScoreProbabilities(probabilities, levels) {
  if (!probabilities) return null
  if (Array.isArray(probabilities)) {
    if (probabilities.length === 0) return null
    return levels.map((_, i) => {
      const v = probabilities[i]
      return typeof v === 'number' && !Number.isNaN(v) ? clamp01(v) : 0
    })
  }
  if (isPlainObject(probabilities)) {
    const out = new Array(levels.length).fill(0)
    let matched = false
    for (const [k, v] of Object.entries(probabilities)) {
      if (typeof v !== 'number' || Number.isNaN(v)) continue
      const numKey = Number(k)
      if (Number.isInteger(numKey) && numKey >= 0 && numKey < levels.length) {
        out[numKey] = clamp01(v)
        matched = true
        continue
      }
      const norm = normalizeLevelName(k, levels)
      if (norm) {
        out[levels.indexOf(norm)] = clamp01(v)
        matched = true
      }
    }
    return matched ? out : null
  }
  return null
}

/**
 * Parse an ordinal `score` answer with risk-aware tail-probability escalation.
 * Prevents bimodal distributions (e.g. 55% public + 40% secret -> mean ~1.2)
 * from silently passing as low-risk "internal".
 *
 * @param {unknown} raw
 * @param {readonly string[]} [levels=SECURITY_LEVELS]
 * @param {object} [opts]
 */
export function parseScoreWithRisk(raw, levels = SECURITY_LEVELS, opts = {}) {
  const parsed = parseAnswer(raw)
  if (!parsed || !Array.isArray(levels) || levels.length === 0) return null

  const highRiskMinIndex = Number.isInteger(opts.highRiskMinIndex) ? opts.highRiskMinIndex : 2
  const tailThreshold = typeof opts.tailThreshold === 'number'
    ? opts.tailThreshold
    : DEFAULT_SECURITY_TAIL_THRESHOLD
  const lowConfidenceThreshold = typeof opts.lowConfidenceThreshold === 'number'
    ? opts.lowConfidenceThreshold
    : DEFAULT_LOW_CONFIDENCE_THRESHOLD
  const escalateToIndex = Number.isInteger(opts.escalateToIndex)
    ? Math.min(levels.length - 1, Math.max(0, opts.escalateToIndex))
    : Math.min(levels.length - 1, highRiskMinIndex)

  const probs = normalizeScoreProbabilities(parsed.probabilities, levels)

  let rawIndex
  let numericValue
  if (parsed.kind === 'score') {
    numericValue = parsed.value
    rawIndex = Math.max(0, Math.min(levels.length - 1, Math.round(parsed.value)))
  } else if (parsed.kind === 'choice') {
    const norm = normalizeLevelName(parsed.value, levels)
    if (!norm) return null
    rawIndex = levels.indexOf(norm)
    numericValue = rawIndex
  } else {
    return null
  }

  let highRiskTailProb = 0
  if (probs) {
    for (let i = highRiskMinIndex; i < probs.length; i++) {
      highRiskTailProb += probs[i]
    }
    highRiskTailProb = Number(clamp01(highRiskTailProb).toFixed(6))
  }

  let index = rawIndex
  let escalated = false
  if (probs && highRiskTailProb >= tailThreshold && index < escalateToIndex) {
    index = escalateToIndex
    escalated = true
  }

  let confidence = parsed.confidence
  if (confidence === null && probs) {
    confidence = probs[rawIndex]
  }
  const lowConfidence = typeof confidence === 'number' && confidence < lowConfidenceThreshold

  return {
    kind: 'score',
    level: levels[index],
    index,
    rawLevel: levels[rawIndex],
    rawIndex,
    value: numericValue,
    confidence,
    bucket: bucketConfidence(confidence),
    lowConfidence,
    escalated,
    highRiskTailProb,
    probabilities: probs,
  }
}

function parseVisibilityAnswer(raw, fallbackThreshold = DEFAULT_VISIBILITY_FALLBACK_THRESHOLD) {
  const parsed = parseAnswer(raw)
  if (!parsed) return null

  let rawLevel = null
  let sourceKind = parsed.kind
  let confidence = parsed.confidence

  if (parsed.kind === 'choice') {
    rawLevel = normalizeLevelName(parsed.value, VISIBILITY_LEVELS)
  } else if (parsed.kind === 'score') {
    const idx = Math.max(0, Math.min(VISIBILITY_LEVELS.length - 1, Math.round(parsed.value)))
    rawLevel = VISIBILITY_LEVELS[idx]
    if (confidence === null) {
      const probs = normalizeScoreProbabilities(parsed.probabilities, VISIBILITY_LEVELS)
      if (probs) confidence = probs[idx]
    }
  }

  if (!rawLevel) return null

  const lowConfidence = typeof confidence === 'number' && confidence < fallbackThreshold
  const level = lowConfidence ? 'short_summary' : rawLevel
  const index = VISIBILITY_LEVELS.indexOf(level)

  return {
    kind: 'choice',
    sourceKind,
    level,
    index,
    rawLevel,
    fallback: lowConfidence && level !== rawLevel,
    lowConfidence,
    confidence,
    bucket: bucketConfidence(confidence),
    probabilities: parsed.probabilities,
  }
}

function parseCacheAnswer(raw) {
  const parsed = parseAnswer(raw)
  if (!parsed) return null

  if (parsed.kind === 'noul') {
    const noul = parseNoul(raw, 0.5)
    return {
      kind: 'noul',
      sourceKind: 'noul',
      reuse: noul.value,
      action: noul.value ? 'reuse' : 'rebuild',
      probability: noul.probability,
      confidence: noul.confidence,
      bucket: noul.bucket,
      lowConfidence: noul.lowConfidence,
      probabilities: noul.probabilities,
    }
  }

  if (parsed.kind === 'choice' && typeof parsed.value === 'string') {
    const lower = parsed.value.trim().toLowerCase()
    const reuse = lower === 'reuse'
    const action = lower === 'rebuild' ? 'rebuild' : (reuse ? 'reuse' : 'rebuild')
    const conf = parsed.confidence
    const probability = reuse
      ? (typeof conf === 'number' ? conf : 1)
      : (typeof conf === 'number' ? clamp01(1 - conf) : 0)
    return {
      kind: 'noul',
      sourceKind: 'choice',
      reuse: action === 'reuse',
      action,
      probability,
      confidence: conf,
      bucket: bucketConfidence(conf),
      lowConfidence: typeof conf === 'number' && conf < DEFAULT_LOW_CONFIDENCE_THRESHOLD,
      probabilities: parsed.probabilities,
    }
  }

  return null
}

function parseEnumChoice(raw, allowed, fallbackValue) {
  const parsed = parseAnswer(raw)
  if (!parsed) return null

  let value = null
  if (parsed.kind === 'choice' && typeof parsed.value === 'string') {
    value = normalizeLevelName(parsed.value, allowed)
  }
  const resolved = value || fallbackValue
  const conf = parsed.confidence
  return {
    kind: 'choice',
    value: resolved,
    rawValue: parsed.value,
    confidence: conf,
    bucket: bucketConfidence(conf),
    lowConfidence: typeof conf === 'number' && conf < DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    probabilities: parsed.probabilities,
  }
}

function parsePermissionsAnswer(raw) {
  const parsed = parseAnswer(raw)
  if (!parsed) return null

  if (parsed.kind === 'choice') {
    const action = normalizeLevelName(parsed.value, PERMISSION_ACTIONS)
    if (!action) return null
    const conf = parsed.confidence
    return {
      kind: 'choice',
      sourceKind: 'choice',
      action,
      confidence: conf,
      bucket: bucketConfidence(conf),
      lowConfidence: typeof conf === 'number' && conf < DEFAULT_LOW_CONFIDENCE_THRESHOLD,
      legacyNoul: false,
      probability: null,
      probabilities: parsed.probabilities,
    }
  }

  if (parsed.kind === 'noul') {
    const prob = parsed.value
    const isExplicitFalse = raw && typeof raw === 'object' && raw.noul === false
    const action = isExplicitFalse ? 'deny' : (prob < 0.2 ? 'ask' : 'allow')
    const conf = isExplicitFalse ? (parsed.confidence ?? 1) : parsed.confidence
    return {
      kind: 'choice',
      sourceKind: 'noul',
      action,
      confidence: conf,
      bucket: bucketConfidence(conf),
      lowConfidence: prob < 0.2,
      legacyNoul: true,
      probability: prob,
      probabilities: parsed.probabilities,
    }
  }

  return null
}

/**
 * Parse a complete JeV System One decision payload (or bare answers map) into
 * normalized, strongly-typed Table I harness decisions.
 * @param {object} rawDecision
 */
export function parseDecision(rawDecision) {
  const hasWrapper = isPlainObject(rawDecision) && isPlainObject(rawDecision.answers)
  const answers = hasWrapper
    ? rawDecision.answers
    : (isPlainObject(rawDecision) ? rawDecision : {})

  const contextVisibility = parseVisibilityAnswer(answers.context_visibility)
  const cachePrefix = parseCacheAnswer(answers.cache_prefix)
  const routing = parseEnumChoice(answers.routing, ROUTING_MODES, 'frontier')
  const tools = parseEnumChoice(answers.tools, TOOL_STRATEGIES, 'targeted')
  const permissions = parsePermissionsAnswer(answers.permissions)
  const security = parseScoreWithRisk(answers.security, SECURITY_LEVELS)

  /** @type {Record<string, ReturnType<typeof parseVisibilityAnswer>>} */
  const chunkVisibility = {}
  for (const [key, val] of Object.entries(answers)) {
    if (!key.startsWith('chunk_vis_')) continue
    const chunkId = key.slice('chunk_vis_'.length)
    if (!chunkId) continue
    const parsedChunk = parseVisibilityAnswer(val)
    if (parsedChunk) {
      chunkVisibility[chunkId] = parsedChunk
    }
  }

  return {
    model: hasWrapper && typeof rawDecision.model === 'string' ? rawDecision.model : null,
    usage: hasWrapper && isPlainObject(rawDecision.usage) ? rawDecision.usage : null,
    requestId: hasWrapper && typeof rawDecision.requestId === 'string' ? rawDecision.requestId : null,
    latencyMs: hasWrapper && typeof rawDecision.latencyMs === 'number' ? rawDecision.latencyMs : null,
    context_visibility: contextVisibility,
    chunk_visibility: chunkVisibility,
    cache_prefix: cachePrefix,
    routing,
    tools,
    permissions,
    security,
    rawAnswers: answers,
  }
}
