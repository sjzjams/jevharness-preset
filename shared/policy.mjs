/**
 * JEVHarness / shared/policy.mjs
 *
 * Implements:
 * - §IV.A Programmable permission gates (deterministic secret denies, PTC run_code
 *   static analysis, pre-execution local script body egress inspection, outside-
 *   workspace write protection, and JeV collaborative gating)
 * - §IX Table IV Security-aware routing trust matrix
 * - §II.A Context-rebuild-aware routing cost estimator
 *
 * Pure Node 20+ ESM, zero external dependencies.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { parseDecision } from './answers.mjs'

const MAX_SCRIPT_INSPECT_BYTES = 65536
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\]|::1)$/i
const URL_RE = /\b(?:https?|wss?|ftp):\/\/(\[[^\]]+\](?::\d+)?[^\s'"`\)\}>,;]*|[^\s'"`\)\]\}>,;]+)/gi
const HOST_PORT_RE = /\b(?:host|hostname)\s*[:=]\s*['"`]([^'"`]+)['"`]/gi
const CLI_HOST_RE = /\b(?:curl|wget|ssh|scp|nc|ncat)\b[^\r\n;|&]*?\s+(?:-[a-zA-Z0-9]+\s+)*(?:https?:\/\/)?([a-zA-Z0-9._:\[\]-]+(?:\.[a-zA-Z0-9-]+|:[0-9]+))/gi

export const DEFAULT_POLICY = Object.freeze({
  secretPathPatterns: Object.freeze([
    /(?:^|[\\/\s'"`(])\.env(?:\.[a-z0-9_.-]+)?(?:$|[\\/\s'"`),;:])/i,
    /(?:^|[\\/\s'"`(])\.ssh(?:$|[\\/\s'"`),;:])/i,
    /\bid_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?\b/i,
    /\bprivate[_-]?key\b/i,
    /\bapi[_-]?key\b/i,
    /\bcredentials?(?:\.[a-z0-9]+)?\b/i,
    /(?:^|[\\/\s'"`(])passwd\b/i,
    /\.pem\b/i,
    /\bwxid(?:_[a-z0-9_-]+)?\b/i,
    /\b\.npmrc\b/i,
    /\b\.netrc\b/i,
  ]),

  sensitivePathPatterns: Object.freeze([
    /(?:^|[\\/\s'"`(])\.env(?:\.[a-z0-9_.-]+)?(?:$|[\\/\s'"`),;:])/i,
    /(?:^|[\\/\s'"`(])\.ssh(?:$|[\\/\s'"`),;:])/i,
    /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i,
    /\bprivate[_-]?key\b/i,
    /\bapi[_-]?key\b/i,
    /\bcredentials?\b/i,
    /\bpasswd\b/i,
    /\.pem\b/i,
    /\bwxid\b/i,
    /\btoken\b/i,
    /\bsecret\b/i,
    /\bpassword\b/i,
    /\bcookie\b/i,
    /\bsession\b/i,
  ]),

  networkEgressPatterns: Object.freeze([
    /\bfetch\s*\(/i,
    /\bhttps?\.request\s*\(/i,
    /\bhttps?\.get\s*\(/i,
    /\baxios\b/i,
    /\bcurl\s+/i,
    /\bwget\s+/i,
    /\bInvoke-WebRequest\b/i,
    /\bInvoke-RestMethod\b/i,
    /\bnew\s+WebSocket\s*\(/i,
    /\bWebSocket\s*\(/i,
    /\bnet\.(?:connect|createConnection)\s*\(/i,
    /\btls\.connect\s*\(/i,
    /\bdns\.(?:lookup|resolve|resolve4|resolve6|resolveTxt)\s*\(/i,
    /\b(?:nc|ncat)\s+/i,
    /\bssh\s+/i,
    /\burllib\.request\b/i,
    /\brequests\.(?:get|post|put|delete|patch|head|request)\s*\(/i,
    /\bhttpx\.(?:get|post|put|delete|patch|Client|AsyncClient)\b/i,
    /\btools\.web_(?:fetch|search)\b/i,
  ]),

  readOnlyTools: Object.freeze([
    'read',
    'glob',
    'grep',
    'read_image',
    'working_directory',
    'list_agents',
    'list_experts',
    'list_expert_teams',
    'list_subagent_models',
    'job_list',
    'job_output',
    'get_goal',
    'jev_decide',
    'jev_chunk_read',
    'jev_retrieval_pack',
    'mnemon_recall',
    'mnemon_related',
    'mnemon_document_search',
    'mnemon_memory_bodies',
    'mnemon_status',
  ]),

  destructiveTools: Object.freeze([
    'write',
    'edit',
    'apply_patch',
    'fs_write',
    'fs_edit',
    'rm',
    'delete',
    'move',
    'mv',
    'pwsh',
    'bash',
    'shell',
    'exec',
    'terminal',
    'command',
    'run_code',
  ]),

  routingTrustMatrix: Object.freeze({
    public: Object.freeze({
      policy: 'open',
      allowCheap: true,
      allowOpenWeight: true,
      allowVetted: true,
      firstPartyFrontierOnly: false,
    }),
    internal: Object.freeze({
      policy: 'standard',
      allowCheap: false,
      allowOpenWeight: false,
      allowVetted: true,
      firstPartyFrontierOnly: false,
    }),
    sensitive: Object.freeze({
      policy: 'restricted',
      allowCheap: false,
      allowOpenWeight: false,
      allowVetted: false,
      firstPartyFrontierOnly: true,
    }),
    secret: Object.freeze({
      policy: 'restricted',
      allowCheap: false,
      allowOpenWeight: false,
      allowVetted: false,
      firstPartyFrontierOnly: true,
    }),
  }),

  firstPartyProviders: Object.freeze([
    'anthropic',
    'openai',
    'deepseek',
    'google',
    'trae-global',
    'first-party',
  ]),

  vettedProviders: Object.freeze([
    'anthropic',
    'openai',
    'deepseek',
    'google',
    'trae-global',
    'azure',
    'bedrock',
    'vertex',
    'first-party',
  ]),

  gatewayProviders: Object.freeze([
    'magpie',
    'magpie-responses',
    'local-gateway',
  ]),

  unvettedProviders: Object.freeze([
    'openrouter',
    'together',
    'groq',
    'fireworks',
    'deepinfra',
    'replicate',
    'huggingface',
    'ollama',
    'vllm',
    'lmstudio',
    'third-party',
    'cheap',
  ]),

  cheapModelPatterns: Object.freeze([
    /(?:^|[-_/:])(?:mini|nano|lite|micro|tiny|small|haiku|flash|instant|cheap)(?:$|[-_/:0-9.])/i,
    /(?:^|[-_/:])(?:llama|qwen|mistral|mixtral|gemma|phi|yi)(?:$|[-_/:0-9.])/i,
  ]),

  excludedVendors: Object.freeze([]),
})

const PATH_ARG_KEYS = [
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
]

const WRITE_TOOL_RE = /^(?:write|edit|apply_patch|fs_write|fs_edit)$/i
const SHELL_TOOL_RE = /^(?:pwsh|bash|shell|exec|terminal|command)$/i

const PTC_WRITE_CALL_RE = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|rm(?:Sync)?|unlink(?:Sync)?|rmdir(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?|cp(?:Sync)?|mkdir(?:Sync)?|truncate(?:Sync)?|createWriteStream|tools\s*\.\s*(?:write|edit)|tools\s*\[\s*['"`](?:write|edit)['"`]\s*\])/i
const SCRIPT_INVOCATION_RE = /(?:^|[;&|\n]\s*)(?:node|python3?|py|bash|sh|pwsh|powershell|deno\s+run|bun|ts-node)\s+(?:(?:-[a-zA-Z0-9-]+(?:\s+[^\s;&|]+)?\s+)*)?(['"`]?)([^\s'"`;&|]+\.(?:m?js|cjs|ts|py|sh|ps1))\1/gi

// Path-taking write/delete helpers. Longer names must precede their prefixes so the
// trailing "\s*\(" anchor matches the complete callee name.
const PTC_WRITE_PATH_CALLS = Object.freeze([
  {
    re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|truncateSync|truncate|rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|mkdirSync|mkdir)\s*\(/g,
    pathArgs: [0],
  },
  {
    re: /\b(?:renameSync|rename|copyFileSync|copyFile|cpSync|cp)\s*\(/g,
    pathArgs: [0, 1],
  },
])
const PTC_TOOLS_WRITE_RE = /\btools\s*(?:\.\s*(?:write|edit)|\[\s*['"`](?:write|edit)['"`]\s*\])\s*\(/g
// Filesystem READ/stat helpers and process-spawn helpers: their arguments are the
// only honest place a sensitive path can appear. ptc-secret-access scans these
// call arguments rather than the whole script, so documentation text that merely
// names a sensitive file is never treated as real access.
const PTC_READ_PATH_CALLS = Object.freeze([
  {
    re: /\b(?:readFileSync|readFile|createReadStream|openSync|open|opendirSync|opendir|readdirSync|readdir|statSync|stat|lstatSync|lstat|accessSync|access|existsSync|exists|realpathSync|realpath|readlinkSync|readlink)\s*\(/g,
    pathArgs: [0],
  },
  {
    re: /\b(?:copyFileSync|copyFile|cpSync|cp|renameSync|rename)\s*\(/g,
    pathArgs: [0, 1],
  },
])
const PTC_PROCESS_ARG_CALLS = Object.freeze([
  {
    re: /\b(?:execSync|exec|execFileSync|execFile|spawnSync|spawn|fork)\s*\(/g,
    pathArgs: [0, 1],
  },
])
// process.env.NAME reads: a secret-named environment variable is a sensitive read.
const PTC_ENV_READ_RE = /\bprocess\s*\.\s*env\s*\.\s*([A-Za-z_$][\w$]*)/g
// Process-spawning builtins and shell tools can write, delete or run arbitrary
// commands, so a run_code that uses them must NOT be exempted as read-only.
const PTC_PROCESS_CALL_RE = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\bchild_process\b|\btools\s*\.\s*(?:pwsh|bash|shell|exec|terminal|command)\b/i
const OBJECT_PATH_KEYS = Object.freeze([
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'target',
  'dest',
  'destination',
  'output',
  'input',
  'src',
  'source',
])

/**
 * Coarse read/write classification of a PTC run_code script body.
 * A script that only reads / computes is graded read-only; any write/delete/mkdir
 * call upgrades it to a write. Used both by the permission gate (so read-only
 * run_code is not treated as destructive) and by chunk access grading.
 *
 * @param {unknown} code
 * @returns {'read' | 'write'}
 */
export function classifyRunCodeAccess(code) {
  if (typeof code !== 'string' || !code.trim()) return 'read'
  // Mask string-literal and comment contents first: a bare mention of
  // "writeFileSync"/"spawn" inside a comment or a quoted string must not upgrade
  // an otherwise read-only script to a write. Real call sites survive the mask.
  const masked = maskNonCode(code)
  if (PTC_WRITE_CALL_RE.test(masked) || PTC_PROCESS_CALL_RE.test(masked)) return 'write'
  return 'read'
}

function mergePolicy(custom) {
  if (!custom || typeof custom !== 'object') return DEFAULT_POLICY
  return {
    ...DEFAULT_POLICY,
    ...custom,
    routingTrustMatrix: custom.routingTrustMatrix
      ? { ...DEFAULT_POLICY.routingTrustMatrix, ...custom.routingTrustMatrix }
      : DEFAULT_POLICY.routingTrustMatrix,
  }
}

function matchesAny(text, patterns) {
  if (!text || !Array.isArray(patterns)) return false
  for (const re of patterns) {
    if (re instanceof RegExp) {
      re.lastIndex = 0
      if (re.test(text)) return true
    }
  }
  return false
}

function isToolInList(toolName, list) {
  const lower = String(toolName || '').toLowerCase()
  return Array.isArray(list) && list.some((t) => String(t).toLowerCase() === lower)
}

function extractTargetPaths(args) {
  const out = []
  if (!args || typeof args !== 'object') return out
  for (const key of PATH_ARG_KEYS) {
    const val = args[key]
    if (typeof val === 'string' && val.trim()) {
      out.push(val.trim())
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

function normalizePathForCompare(p) {
  const resolved = resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Determine whether candidatePath resolves outside cwd.
 * Handles both Windows drive-letter paths and POSIX absolute paths safely.
 */
export function isOutsideWorkspace(candidatePath, cwd) {
  if (!candidatePath || !cwd) return false
  const trimmed = String(candidatePath).trim()
  if (!trimmed) return false
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\') || trimmed === '~') {
    return true
  }
  // On Windows, a POSIX-style root path like /etc/passwd or /tmp/out is outside cwd
  if (process.platform === 'win32' && /^\/(?!\/)/.test(trimmed)) {
    return true
  }
  const resolvedCwd = normalizePathForCompare(cwd)
  const resolvedTarget = normalizePathForCompare(resolve(cwd, trimmed))
  const rel = relative(resolvedCwd, resolvedTarget)
  if (!rel) return false
  return rel === '..' || rel.startsWith('..' + '\\') || rel.startsWith('../') || isAbsolute(rel)
}

function extractHostFromAuthority(authority) {
  if (!authority) return ''
  // Strip userinfo@
  const atIdx = authority.lastIndexOf('@')
  const hostPort = atIdx !== -1 ? authority.slice(atIdx + 1) : authority
  // Strip path/query/fragment
  const slashIdx = hostPort.search(/[/?#]/)
  const clean = slashIdx !== -1 ? hostPort.slice(0, slashIdx) : hostPort
  // IPv6 bracketed host
  if (clean.startsWith('[')) {
    const end = clean.indexOf(']')
    return end !== -1 ? clean.slice(0, end + 1) : clean
  }
  // Strip :port
  const colonIdx = clean.indexOf(':')
  return colonIdx !== -1 ? clean.slice(0, colonIdx) : clean
}

function isLoopbackHost(host) {
  if (!host) return false
  const trimmed = host.trim()
  return LOOPBACK_HOST_RE.test(trimmed)
}

/**
 * Inspect code/script text for network egress calls.
 * Built-in loopback whitelist: if every detected network statement exclusively
 * targets 127.0.0.1 / localhost / ::1, returns { detected: false, reason: 'loopback-only' }.
 * Any non-loopback host or dynamic/unresolved network target counts as external egress.
 */
export function detectExternalNetworkEgress(text, policy = DEFAULT_POLICY) {
  if (typeof text !== 'string' || !text.trim()) {
    return { detected: false, matchedPatterns: [], externalHosts: [] }
  }
  const patterns = policy.networkEgressPatterns || DEFAULT_POLICY.networkEgressPatterns
  const lines = text.split(/\r?\n/)
  const externalHosts = []
  const matchedLines = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('//') || line.startsWith('#')) continue
    if (!matchesAny(line, patterns)) continue

    // Extract explicit URLs and host declarations on this line
    const hosts = []
    URL_RE.lastIndex = 0
    let m
    while ((m = URL_RE.exec(line)) !== null) {
      hosts.push(extractHostFromAuthority(m[1]))
    }

    HOST_PORT_RE.lastIndex = 0
    while ((m = HOST_PORT_RE.exec(line)) !== null) {
      hosts.push(extractHostFromAuthority(m[1]))
    }

    if (hosts.length === 0) {
      CLI_HOST_RE.lastIndex = 0
      while ((m = CLI_HOST_RE.exec(line)) !== null) {
        const candidate = m[1]
        if (!candidate.startsWith('-')) {
          hosts.push(extractHostFromAuthority(candidate))
        }
      }
    }

    // Also check direct string argument like net.connect(8080, '127.0.0.1') or dns.lookup('localhost')
    if (hosts.length === 0) {
      const strArgs = line.match(/['"`](127\.0\.0\.1|localhost|::1|\[::1\])['"`]/gi)
      if (strArgs && strArgs.length > 0) {
        for (const s of strArgs) {
          hosts.push(s.slice(1, -1))
        }
      }
    }

    if (hosts.length === 0) {
      // Dynamic or unresolved target (e.g. fetch(url)) -> treat conservatively as external egress
      matchedLines.push(line.slice(0, 120))
      externalHosts.push('<dynamic>')
      continue
    }

    const nonLoopback = hosts.filter((h) => !isLoopbackHost(h))
    if (nonLoopback.length > 0) {
      matchedLines.push(line.slice(0, 120))
      externalHosts.push(...nonLoopback)
    }
  }

  return {
    detected: matchedLines.length > 0,
    matchedLines,
    externalHosts,
  }
}

/**
 * Return the source text between the parenthesis at openIdx and its balanced
 * closing parenthesis, respecting single/double/backtick string literals.
 */
function extractBalancedCallArgs(code, openIdx) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < code.length; i += 1) {
    const ch = code[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1
      if (depth === 0) return code.slice(openIdx + 1, i)
    }
  }
  return code.slice(openIdx + 1)
}

/**
 * Split a call's argument list on top-level commas (ignoring commas inside
 * nested brackets or string literals).
 */
function splitTopLevelArgs(argText) {
  const args = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i < argText.length; i += 1) {
    const ch = argText[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) {
      args.push(argText.slice(start, i))
      start = i + 1
    }
  }
  args.push(argText.slice(start))
  return args
}

/**
 * Extract the static string value of an argument only when it is a single
 * plain string/template literal with no interpolation. Dynamic expressions
 * (variables, concatenation, template interpolation) return null so the
 * detector never guesses at a path that is not statically present.
 */
function extractStaticStringLiteral(argText) {
  const text = String(argText || '').trim()
  if (!text) return null
  const quote = text[0]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null
  // Find the closing unescaped quote; the remainder must be empty (pure literal).
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
      continue
    }
    if (text[i] === quote) {
      const rest = text.slice(i + 1).trim()
      if (rest) return null
      const body = text.slice(1, i)
      // Interpolated template literals are dynamic -> do not guess a path.
      if (quote === '`' && body.includes('${')) return null
      return body
    }
  }
  return null
}

/**
 * Replace the contents of string literals and comments with spaces, preserving
 * length and newlines. Call-site discovery runs on this mask so that text such
 * as "tools.edit({ file_path: '/tmp/x' })" appearing inside a comment or a
 * string is never mistaken for a real write call. Template-literal
 * interpolations (${...}) are kept as code so writes inside them are still seen.
 */
function maskNonCode(src) {
  const n = src.length
  const out = src.split('')
  let i = 0
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === '/' && c2 === '/') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < n && src[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (c === '/' && c2 === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' '
        i += 1
      }
      if (i < n) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    if (c === "'" || c === '"') {
      out[i] = ' '
      i += 1
      while (i < n) {
        const d = src[i]
        if (d === '\\') {
          if (src[i] !== '\n') out[i] = ' '
          if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '
          i += 2
          continue
        }
        if (d === '\n') {
          i += 1
          continue
        }
        out[i] = ' '
        i += 1
        if (d === c) break
      }
      continue
    }
    if (c === '`') {
      out[i] = ' '
      i += 1
      while (i < n) {
        const d = src[i]
        if (d === '\\') {
          if (src[i] !== '\n') out[i] = ' '
          if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = ' '
          i += 2
          continue
        }
        if (d === '$' && src[i + 1] === '{') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          let depth = 1
          while (i < n && depth > 0) {
            const e = src[i]
            if (e === '{') {
              depth += 1
              i += 1
              continue
            }
            if (e === '}') {
              depth -= 1
              out[i] = ' '
              i += 1
              continue
            }
            if (e === "'" || e === '"') {
              // keep interpolation code visible, but skip a quoted string so a
              // brace inside it does not change the nesting depth
              const q = e
              i += 1
              while (i < n) {
                const f = src[i]
                if (f === '\\') { i += 2; continue }
                if (f === q) { i += 1; break }
                i += 1
              }
              continue
            }
            i += 1
          }
          continue
        }
        if (d === '\n') {
          out[i] = '\n'
          i += 1
          continue
        }
        out[i] = ' '
        i += 1
        if (d === '`') break
      }
      continue
    }
    i += 1
  }
  return out.join('')
}

function looksPathyFragment(frag) {
  // Keep '..' as a suspicious fragment: path.join('..', x) escapes the repo even
  // though the '..' segment carries no separator of its own.
  if (!frag || frag === '.') return false
  return (
    /^[a-zA-Z]:[\\/]/.test(frag) ||
    /^[\\/]/.test(frag) ||
    /^~[\\/]/.test(frag) ||
    frag.includes('/') ||
    frag.includes('\\') ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(frag)
  )
}

/**
 * Collect path candidates from one argument expression. A static literal is
 * returned directly; for a dynamic expression (path.join(..), templates,
 * concatenation) every path-looking string fragment is returned so the caller
 * can conservatively catch writes such as fs.writeFileSync(path.join('/tmp', x)).
 */
function collectPathFragments(argText) {
  const staticLit = extractStaticStringLiteral(argText)
  if (staticLit !== null) return staticLit ? [staticLit] : []
  const text = String(argText || '')
  const frags = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  let m
  while ((m = re.exec(text)) !== null) {
    const body = m[2]
    if (!body) continue
    if (looksPathyFragment(body)) frags.push(body)
  }
  return frags
}

/**
 * For an object-literal argument like { file_path: 'x', content: 'y' }, return
 * the first statically known path-valued property. Non-path properties (e.g.
 * content) are intentionally ignored so their text cannot cause false positives.
 */
function extractObjectPathLiteral(argText) {
  const text = String(argText || '').trim()
  if (!text.startsWith('{')) return null
  const keyRe = /(?:^|[,{}])\s*(['"]?)([a-zA-Z_$][\w$]*)\1\s*:\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g
  let m
  while ((m = keyRe.exec(text)) !== null) {
    const key = m[2]
    if (!OBJECT_PATH_KEYS.includes(key)) continue
    const value = m[4]
    if (m[3] === '`' && value.includes('${')) continue
    return value
  }
  return null
}

/**
 * For an object-literal argument, return the raw value expression of every
 * property whose key names a path (OBJECT_PATH_KEYS). This lets the caller scan
 * ONLY the path-valued properties of dynamic object literals such as
 * { file_path: p } or { file_path: path.join('..', x) }, never sibling payload
 * strings (content, data, ...) whose text must not be mistaken for a target.
 */
const OBJECT_KEY_PREFIX_RE = /^\s*(?:['"])?([A-Za-z_$][\w$]*)(?:['"])?\s*:/
function extractObjectPathValueExprs(argText) {
  const text = String(argText || '').trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return []
  const chunks = splitTopLevelArgs(text.slice(1, -1))
  const out = []
  for (const chunk of chunks) {
    const m = OBJECT_KEY_PREFIX_RE.exec(chunk)
    if (!m) continue
    if (!OBJECT_PATH_KEYS.includes(m[1])) continue
    out.push(chunk.slice(m[0].length).trim())
  }
  return out
}

/**
 * Inspect PTC run_code source for outside-workspace write/delete calls.
 *
 * Only the path arguments actually passed to a write/delete callee are checked.
 * Read-only path literals elsewhere in the script (reads, log messages, data
 * payloads, docs) are ignored, which removes the historical false positives
 * where a script that merely *mentions* an external path was flagged as
 * writing outside the repo.
 */
function detectPtcOutsideWorkspaceWrite(code, cwd) {
  if (!cwd || typeof code !== 'string' || !code.trim()) return null

  // Discover real call sites on a mask where string/comment contents are blanked,
  // so "tools.edit(...)" quoted in a log line or comment is never parsed.
  const masked = maskNonCode(code)

  const consider = (literal) => {
    if (typeof literal !== 'string') return null
    const lit = literal.trim()
    if (!lit) return null
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(lit)) return null // URL, not a filesystem path
    return isOutsideWorkspace(lit, cwd) ? lit : null
  }

  const considerArg = (argText) => {
    for (const frag of collectPathFragments(argText)) {
      const hit = consider(frag)
      if (hit) return hit
    }
    return null
  }

  // Function-style write/delete calls: inspect only their path argument(s).
  for (const group of PTC_WRITE_PATH_CALLS) {
    group.re.lastIndex = 0
    let m
    while ((m = group.re.exec(masked)) !== null) {
      const openIdx = m.index + m[0].length - 1
      const args = splitTopLevelArgs(extractBalancedCallArgs(code, openIdx))
      for (const argIndex of group.pathArgs) {
        const hit = considerArg(args[argIndex])
        if (hit) return hit
      }
    }
  }

  // tools.write({ file_path: ... }) / tools.edit({ path: ... }) style calls.
  PTC_TOOLS_WRITE_RE.lastIndex = 0
  let tm
  while ((tm = PTC_TOOLS_WRITE_RE.exec(masked)) !== null) {
    const openIdx = tm.index + tm[0].length - 1
    const args = splitTopLevelArgs(extractBalancedCallArgs(code, openIdx))
    const arg0 = args[0]
    const objLit = extractObjectPathLiteral(arg0)
    if (objLit !== null) {
      const hit = consider(objLit)
      if (hit) return hit
      continue
    }
    // Dynamic path (e.g. file_path: someVar). Inspect ONLY the path-valued
    // properties of the object literal. Sibling payload strings such as
    // content: "saved /tmp/x" must never be mistaken for a write target.
    const pathExprs = extractObjectPathValueExprs(arg0)
    if (pathExprs.length) {
      for (const expr of pathExprs) {
        const hit = considerArg(expr)
        if (hit) return hit
      }
    } else if (!String(arg0 || '').trim().startsWith('{')) {
      // Not an object literal (e.g. tools.write(someExpr)): inspect the argument.
      const hit = considerArg(arg0)
      if (hit) return hit
    }
  }

  return null
}

/**
 * Detect sensitive-path access in a PTC run_code script by inspecting only the
 * arguments of filesystem, process-command and environment-variable read calls.
 * Documentation strings or log text that merely mention a sensitive path are
 * blanked by maskNonCode and never surface as call arguments, so they are
 * ignored (this replaces the historical whole-script scan false positive).
 *
 * @returns {string|null} the offending argument text, or null when clean.
 */
function detectPtcSecretAccess(code, policy = DEFAULT_POLICY) {
  if (typeof code !== 'string' || !code.trim()) return null
  const masked = maskNonCode(code)
  const groups = [...PTC_WRITE_PATH_CALLS, ...PTC_READ_PATH_CALLS, ...PTC_PROCESS_ARG_CALLS]
  for (const group of groups) {
    group.re.lastIndex = 0
    let m
    while ((m = group.re.exec(masked)) !== null) {
      const openIdx = m.index + m[0].length - 1
      const args = splitTopLevelArgs(extractBalancedCallArgs(code, openIdx))
      for (const ai of group.pathArgs) {
        const argText = args[ai]
        if (typeof argText === 'string' && matchesAny(argText, policy.secretPathPatterns)) {
          return argText.trim()
        }
      }
    }
  }
  PTC_ENV_READ_RE.lastIndex = 0
  let em
  while ((em = PTC_ENV_READ_RE.exec(masked)) !== null) {
    if (em[1] && matchesAny(em[1], policy.secretPathPatterns)) return em[1]
  }
  return null
}

/**
 * Safely read up to maxBytes of a local file inside cwd for pre-execution inspection.
 */
function readScriptSnippetInWorkspace(scriptArg, cwd, maxBytes = MAX_SCRIPT_INSPECT_BYTES) {
  if (!scriptArg || !cwd) return null
  if (isOutsideWorkspace(scriptArg, cwd)) return null
  const fullPath = resolve(cwd, scriptArg)
  try {
    const st = statSync(fullPath)
    if (!st.isFile()) return null
    const toRead = Math.min(st.size, maxBytes)
    if (toRead <= 0) return ''
    const buf = Buffer.alloc(toRead)
    const fd = openSync(fullPath, 'r')
    try {
      const bytesRead = readSync(fd, buf, 0, toRead, 0)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function extractScriptPathsFromCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return []
  const scripts = []
  SCRIPT_INVOCATION_RE.lastIndex = 0
  let m
  while ((m = SCRIPT_INVOCATION_RE.exec(command)) !== null) {
    if (m[2]) scripts.push(m[2])
  }
  return scripts
}

function normalizeDecisionInput(decision) {
  if (!decision || typeof decision !== 'object') return null
  // Already parsed by parseDecision if security/permissions have normalized fields or rawAnswers exists
  if ('rawAnswers' in decision || (decision.security && 'index' in decision.security)) {
    return decision
  }
  if ('answers' in decision) {
    return parseDecision(decision)
  }
  return decision
}

function evaluateSubagentRoutingGate({ args, decision, policy }) {
  const provider = typeof args?.provider === 'string' ? args.provider.trim() : ''
  const model = typeof args?.model === 'string' ? args.model.trim() : ''
  if (!provider && !model) return null

  const secLevel = decision?.security?.level || 'internal'
  const matrix = policy.routingTrustMatrix || DEFAULT_POLICY.routingTrustMatrix
  const trustRule = matrix[secLevel] || matrix.internal

  const providerLower = provider.toLowerCase()
  const modelLower = model.toLowerCase()
  const combined = `${providerLower}/${modelLower}`

  // Check Table IV custom excludedVendors across all security levels
  const excluded = Array.isArray(policy.excludedVendors) ? policy.excludedVendors : []
  for (const vendor of excluded) {
    const v = String(vendor || '').trim().toLowerCase()
    if (!v) continue
    if (providerLower.includes(v) || modelLower.includes(v) || combined.includes(v)) {
      return {
        kind: 'deny',
        ruleId: 'routing-excluded-vendor',
        reason: `Subagent routing to "${provider || model}" is blocked by excludedVendors policy ("${vendor}").`,
      }
    }
  }

  const firstParty = (policy.firstPartyProviders || DEFAULT_POLICY.firstPartyProviders)
    .map((p) => String(p).toLowerCase())
  const vetted = (policy.vettedProviders || DEFAULT_POLICY.vettedProviders)
    .map((p) => String(p).toLowerCase())
  const gatewayList = (policy.gatewayProviders || DEFAULT_POLICY.gatewayProviders)
    .map((p) => String(p).toLowerCase())
  const unvetted = (policy.unvettedProviders || DEFAULT_POLICY.unvettedProviders)
    .map((p) => String(p).toLowerCase())
  const cheapPatterns = policy.cheapModelPatterns || DEFAULT_POLICY.cheapModelPatterns

  // Local aggregator gateways (e.g. magpie / magpie-responses / local-gateway):
  // If model carries a "vendor/modelName" prefix, evaluate vendor trust using that prefix;
  // otherwise treat the bare gateway route as vetted (but not first-party).
  const isGateway = providerLower ? gatewayList.includes(providerLower) : false
  const slashIdx = modelLower.indexOf('/')
  const hasVendorPrefix = slashIdx > 0
  const effectiveVendor = isGateway && hasVendorPrefix
    ? modelLower.slice(0, slashIdx).trim()
    : providerLower

  let isFirstParty = false
  let isVetted = false
  let isUnvetted = false

  if (isGateway && !hasVendorPrefix) {
    isFirstParty = false
    isVetted = true
    isUnvetted = false
  } else if (effectiveVendor) {
    isFirstParty = firstParty.includes(effectiveVendor)
    isVetted = vetted.includes(effectiveVendor) || isFirstParty
    isUnvetted = unvetted.some((u) => effectiveVendor.includes(u))
  }

  const isCheapModel = model ? matchesAny(model, cheapPatterns) : false

  // sensitive / secret -> restricted: first-party frontier only
  if (trustRule.firstPartyFrontierOnly) {
    if ((effectiveVendor && !isFirstParty) || isUnvetted || isCheapModel) {
      return {
        kind: 'deny',
        ruleId: 'routing-trust-restricted',
        reason: `Security level "${secLevel}" requires first-party frontier routing only; blocked subagent route "${provider || '<default>'}/${model || '<default>'}".`,
      }
    }
  } else if (!trustRule.allowOpenWeight || trustRule.policy === 'standard') {
    // internal -> standard: vetted providers only, no unvetted/open-weight cheap routes
    if (isUnvetted || (effectiveVendor && !isVetted)) {
      return {
        kind: 'deny',
        ruleId: 'routing-trust-standard',
        reason: `Security level "${secLevel}" requires a vetted provider; blocked subagent route "${provider}/${model || '<default>'}".`,
      }
    }
  }

  return null
}

/**
 * Programmable pre-execution tool gate (§IV.A + Table IV).
 *
 * @param {object} params
 * @param {string} params.toolName
 * @param {Record<string, unknown>} [params.args]
 * @param {object | null} [params.decision]
 * @param {string} [params.cwd]
 * @param {string} [params.taskScope]
 * @param {boolean} [params.approvalDisabled=false]
 * @param {object} [params.policy]
 * @returns {{ kind: 'allow' | 'ask' | 'deny', reason?: string, ruleId: string }}
 */
export function evaluateToolGate({
  toolName = '',
  args = {},
  decision = null,
  cwd = '',
  taskScope = 'default',
  approvalDisabled = false,
  policy: customPolicy = null,
} = {}) {
  const policy = mergePolicy(customPolicy)
  const normTool = String(toolName || '').trim()
  const normDecision = normalizeDecisionInput(decision)
  const paths = extractTargetPaths(args)
  const isShell = SHELL_TOOL_RE.test(normTool)
  const isWriteTool = WRITE_TOOL_RE.test(normTool)
  const commandText = isShell && typeof args?.command === 'string'
    ? args.command
    : (isShell && typeof args?.cmd === 'string' ? args.cmd : '')

  // Target text for path/command rules (intentionally excludes write/edit file bodies!)
  const inspectedTarget = [paths.join(' '), commandText].filter(Boolean).join(' ')

  // Rule 1: Deterministic deny on high-signal secret paths or shell commands
  if (inspectedTarget && matchesAny(inspectedTarget, policy.secretPathPatterns)) {
    return {
      kind: 'deny',
      ruleId: 'deterministic-secret-path',
      reason: 'JEVHarness blocks access to a secret path (.env/.ssh/keys/credentials/passwd/.pem/wxid).',
    }
  }

  // Rule 2: PTC run_code static inspection
  if (normTool.toLowerCase() === 'run_code' && typeof args?.code === 'string') {
    const code = args.code
    const secretHit = detectPtcSecretAccess(code, policy)
    if (secretHit) {
      return {
        kind: 'deny',
        ruleId: 'ptc-secret-access',
        reason: 'JEVHarness blocked run_code because the script references a secret path or credential identifier.',
      }
    }
    if (taskScope !== 'deploy') {
      const egress = detectExternalNetworkEgress(code, policy)
      if (egress.detected) {
        return {
          kind: 'deny',
          ruleId: 'ptc-network-egress',
          reason: `JEVHarness blocked run_code external network egress outside deploy scope (${egress.externalHosts.join(', ')}).`,
        }
      }
    }
    const outsideWritePath = detectPtcOutsideWorkspaceWrite(code, cwd)
    if (outsideWritePath) {
      return {
        kind: approvalDisabled ? 'deny' : 'ask',
        ruleId: 'ptc-outside-workspace-write',
        reason: approvalDisabled
          ? `JEVHarness blocked run_code write/delete outside workspace ("${outsideWritePath}"); approval prompts are disabled so ask degraded to deny.`
          : `run_code writes or deletes outside workspace ("${outsideWritePath}"); confirmation required.`,
      }
    }
  }

  // Rule 3: §IV.A Pre-execution deep inspection of shell commands & local script bodies
  if (isShell && commandText && taskScope !== 'deploy') {
    const directEgress = detectExternalNetworkEgress(commandText, policy)
    if (directEgress.detected) {
      return {
        kind: 'deny',
        ruleId: 'shell-network-egress',
        reason: `JEVHarness blocked shell external network egress outside deploy scope (${directEgress.externalHosts.join(', ')}).`,
      }
    }
    if (cwd) {
      const scripts = extractScriptPathsFromCommand(commandText)
      for (const scriptPath of scripts) {
        const body = readScriptSnippetInWorkspace(scriptPath, cwd, MAX_SCRIPT_INSPECT_BYTES)
        if (body) {
          const scriptEgress = detectExternalNetworkEgress(body, policy)
          if (scriptEgress.detected) {
            return {
              kind: 'deny',
              ruleId: 'script-body-network-egress',
              reason: `JEVHarness inspected local script "${scriptPath}" before execution and blocked external network egress (${scriptEgress.externalHosts.join(', ')}).`,
            }
          }
        }
      }
    }
  }

  // Rule 4: Outside-workspace write protection (write/edit/apply_patch)
  if (isWriteTool && cwd) {
    for (const p of paths) {
      if (isOutsideWorkspace(p, cwd)) {
        return {
          kind: approvalDisabled ? 'deny' : 'ask',
          ruleId: 'outside-workspace-write',
          reason: approvalDisabled
            ? `Write target "${p}" resolves outside workspace root; approval prompts are disabled so ask degraded to deny.`
            : `Write target "${p}" resolves outside workspace root; confirmation required.`,
        }
      }
    }
  }

  // Rule 6: Subagent routing trust gate (Table IV)
  if (normTool.toLowerCase() === 'subagent') {
    const routeVerdict = evaluateSubagentRoutingGate({ args, decision: normDecision, policy })
    if (routeVerdict) return routeVerdict
  }

  // Rule 5: JeV collaborative decision gating
  if (normDecision) {
    const sec = normDecision.security
    const perm = normDecision.permissions
    // PTC run_code is a container: a read-only script (reads / computes only) must
    // not inherit the destructive posture of a write, otherwise an ordinary read
    // script is blocked by permissions=deny / ask-degrade just because the tool
    // happens to be capable of writing. Grade it by its actual script body.
    const isRunCode = normTool.toLowerCase() === 'run_code' && typeof args?.code === 'string'
    const runCodeAccess = isRunCode ? classifyRunCodeAccess(args.code) : null
    const isReadOnly = runCodeAccess
      ? runCodeAccess === 'read'
      : isToolInList(normTool, policy.readOnlyTools)
    const isDestructive = runCodeAccess ? runCodeAccess === 'write' : isToolInList(normTool, policy.destructiveTools)

    if (sec && typeof sec.index === 'number' && sec.index >= 2) {
      if (inspectedTarget && matchesAny(inspectedTarget, policy.sensitivePathPatterns)) {
        return {
          kind: 'deny',
          ruleId: 'jev-security-sensitive-target',
          reason: `JeV security=${sec.level || 'sensitive'} and this call targets a sensitive path; blocked by JEVHarness.`,
        }
      }
    }

    if (perm && perm.action === 'deny' && !isReadOnly) {
      const conf = typeof perm.confidence === 'number' ? perm.confidence : 0
      if (conf >= 0.55) {
        return {
          kind: 'deny',
          ruleId: 'jev-permissions-deny',
          reason: `JeV permissions=deny (confidence ${conf.toFixed(2)}) for tool "${normTool}"; blocked by JEVHarness.`,
        }
      }
    }

    const legacyLowNoul = perm && perm.legacyNoul && typeof perm.probability === 'number' && perm.probability < 0.2
    const askRequested = perm && perm.action === 'ask'
    const lowPermConf = perm && !perm.legacyNoul && typeof perm.confidence === 'number' && perm.confidence < 0.2

    if (isDestructive && (askRequested || legacyLowNoul || lowPermConf)) {
      if (approvalDisabled) {
        return {
          kind: 'deny',
          ruleId: 'jev-permissions-ask-degraded',
          reason: `JeV permissions requires confirmation for destructive tool "${normTool}", and approval prompts are disabled (degraded from ask to deny).`,
        }
      }
      return {
        kind: 'ask',
        ruleId: 'jev-permissions-ask',
        reason: `JeV permissions requires confirmation for destructive tool "${normTool}".`,
      }
    }
  }

  return { kind: 'allow', ruleId: 'allow-default' }
}

/**
 * §II.A Routing cost estimator accounting for prompt-cache context rebuild.
 *
 *   Path 1 (pureFrontier) = frontierOut * Y + frontierIn * Z
 *   Path 2 (routed)       = cheapIn * X + (cheapOut + frontierIn) * Y + (cheapIn + frontierIn) * Z
 *
 * Where X = contextTokens, Y = outputTokens, Z = readTokens.
 * Defaults match the paper's worked example (Opus $5/$25 vs Sonnet $3/$15 per MTok):
 * X=0.65, Y=0.12, Z=0.23 => pureFrontier=4.15 vs routed=6.19.
 */
export function estimateRoutingCost({
  contextTokens = 0,
  outputTokens = 0,
  readTokens = 0,
  frontierIn = 5,
  frontierOut = 25,
  cheapIn = 3,
  cheapOut = 15,
} = {}) {
  const X = Number(contextTokens) || 0
  const Y = Number(outputTokens) || 0
  const Z = Number(readTokens) || 0
  const inF = Number(frontierIn) || 0
  const outF = Number(frontierOut) || 0
  const inC = Number(cheapIn) || 0
  const outC = Number(cheapOut) || 0

  const pureFrontier = outF * Y + inF * Z
  const routed = inC * X + (outC + inF) * Y + (inC + inF) * Z
  const cheaperPath = pureFrontier <= routed ? 'pureFrontier' : 'routed'
  const savingsRatio = pureFrontier > 0
    ? (pureFrontier - routed) / pureFrontier
    : 0

  return {
    pureFrontier: Number(pureFrontier.toFixed(6)),
    routed: Number(routed.toFixed(6)),
    cheaperPath,
    savingsRatio: Number(savingsRatio.toFixed(6)),
  }
}
