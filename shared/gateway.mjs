/**
 * JEVHarness / shared/gateway.mjs
 *
 * Shared Magpie System One gateway client for jev-decide-tool and
 * jev-harness-loop. Pure Node 20+ ESM, zero external dependencies.
 *
 * Only egress is the local Magpie gateway (default http://127.0.0.1:3425/v1),
 * overridable via DSH_MAGPIE_BASE. Bearer token comes from MAGPIE_GATEWAY_KEY
 * or ~/.dsh/.env (cached by file mtime/size to avoid redundant disk reads).
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_BASE = 'http://127.0.0.1:3425/v1'
export const DEFAULT_MODEL = 'typesafe/jev-latest'
export const DEFAULT_TIMEOUT_MS = 60000

/** @type {Map<string, { mtimeMs: number, size: number, value: string | null }>} */
const envKeyCache = new Map()

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function defaultEnvPath() {
  return join(homedir(), '.dsh', '.env')
}

function parseGatewayKeyFromEnvText(text) {
  const match = /^\s*MAGPIE_GATEWAY_KEY\s*=\s*(.+?)\s*$/m.exec(text)
  if (!match) return null
  let raw = match[1].trim()
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1)
  } else {
    // Strip trailing inline comment when unquoted
    const hashIdx = raw.indexOf(' #')
    if (hashIdx !== -1) raw = raw.slice(0, hashIdx).trim()
  }
  return raw || null
}

function redactSecret(text, secret) {
  const str = String(text ?? '')
  if (!secret) return str
  return str.split(secret).join('[REDACTED]')
}

/**
 * Resolve Magpie gateway base URL without trailing slashes.
 * @param {string} [overrideBase]
 * @returns {string}
 */
export function gatewayBase(overrideBase) {
  const raw = overrideBase || process.env.DSH_MAGPIE_BASE || DEFAULT_BASE
  return String(raw).replace(/\/+$/, '')
}

/**
 * Resolve MAGPIE_GATEWAY_KEY from environment or ~/.dsh/.env (mtime-cached).
 * When customEnvPath is explicitly provided, reads from that file (skipping
 * process.env so unit tests can deterministically exercise file/cache logic).
 * @param {string} [customEnvPath]
 * @returns {string | null}
 */
export function gatewayKey(customEnvPath) {
  if (!customEnvPath && process.env.MAGPIE_GATEWAY_KEY) {
    const trimmed = process.env.MAGPIE_GATEWAY_KEY.trim()
    if (trimmed) return trimmed
  }
  const envPath = customEnvPath || defaultEnvPath()
  try {
    const st = statSync(envPath)
    const cached = envKeyCache.get(envPath)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.value
    }
    const content = readFileSync(envPath, 'utf8')
    const value = parseGatewayKeyFromEnvText(content)
    envKeyCache.set(envPath, { mtimeMs: st.mtimeMs, size: st.size, value })
    return value
  } catch {
    envKeyCache.delete(envPath)
    return null
  }
}

/**
 * Clear the mtime-based gateway key cache (useful for tests).
 */
export function clearGatewayKeyCache() {
  envKeyCache.clear()
}

/**
 * Call TypeSafe JeV System One endpoint via the local Magpie gateway.
 *
 * Returns:
 *   { ok: true, model, answers, usage?, requestId?, latencyMs }
 * or:
 *   { ok: false, error, status?, latencyMs }
 *
 * Never leaks apiKey in return values or error messages.
 */
export async function callSystemOne({
  model = DEFAULT_MODEL,
  state,
  questions,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  const startedAt = Date.now()
  const key = apiKey !== undefined ? apiKey : gatewayKey()
  if (!key) {
    return {
      ok: false,
      error: 'MAGPIE_GATEWAY_KEY not found in the environment or ~/.dsh/.env',
      latencyMs: Date.now() - startedAt,
    }
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      error: 'Fetch implementation is unavailable',
      latencyMs: Date.now() - startedAt,
    }
  }

  const effectiveTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS

  const timeoutSignal = AbortSignal.timeout(effectiveTimeout)
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal

  const url = gatewayBase(baseUrl) + '/systemone'
  const body = {
    model: model || DEFAULT_MODEL,
    state,
    questions,
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + key,
      },
      body: JSON.stringify(body),
      signal: combinedSignal,
    })

    const text = await response.text()
    const latencyMs = Date.now() - startedAt

    if (!response.ok) {
      let message = text.slice(0, 500)
      try {
        const parsedError = JSON.parse(text)
        if (isPlainObject(parsedError)) {
          message = parsedError.error?.message || parsedError.detail || message
        }
      } catch { /* keep raw excerpt */ }
      return {
        ok: false,
        status: response.status,
        error: redactSecret(`System One HTTP ${response.status}: ${message}`, key),
        latencyMs,
      }
    }

    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (parseErr) {
      return {
        ok: false,
        status: response.status,
        error: redactSecret('System One returned invalid JSON: ' + String(parseErr?.message || parseErr), key),
        latencyMs,
      }
    }

    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        status: response.status,
        error: 'System One returned non-object JSON payload',
        latencyMs,
      }
    }

    const result = {
      ok: true,
      model: String(parsed.model || body.model || ''),
      answers: isPlainObject(parsed.answers) ? parsed.answers : {},
      latencyMs,
    }
    if (isPlainObject(parsed.usage)) {
      result.usage = parsed.usage
    }
    const requestId = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('x-typesafe-request-id')
      : null
    if (requestId) {
      result.requestId = requestId
    }
    return result
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const errName = error && typeof error === 'object' ? error.name : ''
    let message
    if (timeoutSignal.aborted || errName === 'TimeoutError') {
      message = `JeV request timed out after ${effectiveTimeout}ms`
    } else if (signal?.aborted || errName === 'AbortError') {
      message = 'JeV request aborted'
    } else {
      message = 'JeV request failed: ' + String(error?.message || error)
    }
    return {
      ok: false,
      error: redactSecret(message, key),
      latencyMs,
    }
  }
}
