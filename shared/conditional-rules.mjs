import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const FOOTGUN_FILENAMES = Object.freeze(['FOOTGUNS.md', '.jev-footguns.md']);

/**
 * Module-level file cache keyed by resolved absolute path.
 * Invalidates automatically when mtimeMs or file size changes.
 * @type {Map<string, { mtimeMs: number, size: number, raw: string, frontmatter: Record<string, any> | null, body: string }>}
 */
const fileCache = new Map();

export function clearConditionalRulesCache() {
  fileCache.clear();
}

function toPosix(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function stripLeadingDotSlash(p) {
  let out = toPosix(p);
  while (out.startsWith('./')) {
    out = out.slice(2);
  }
  return out;
}

function compareCodeUnits(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function unquoteScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = trimmed.slice(1, -1);
      if (first === '"') {
        return inner
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
      return inner.replace(/''/g, "'");
    }
  }
  return trimmed;
}

function stripInlineComment(value) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && value[i - 1] !== '\\') {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(value[i - 1])) {
        return value.slice(0, i).trim();
      }
    }
  }
  return value.trim();
}

function splitInlineList(inner) {
  const items = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle && inner[i - 1] !== '\\') {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === ',' && !inSingle && !inDouble) {
      const cleaned = unquoteScalar(current);
      if (cleaned.length > 0) items.push(cleaned);
      current = '';
    } else {
      current += ch;
    }
  }
  const tail = unquoteScalar(current);
  if (tail.length > 0) items.push(tail);
  return items;
}

function parseScalarValue(rawValue) {
  const cleaned = stripInlineComment(rawValue);
  if (cleaned === '') return '';
  if (cleaned === 'true' || cleaned === 'True' || cleaned === 'TRUE') return true;
  if (cleaned === 'false' || cleaned === 'False' || cleaned === 'FALSE') return false;
  if (cleaned === 'null' || cleaned === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(cleaned)) return Number(cleaned);
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    return splitInlineList(cleaned.slice(1, -1));
  }
  return unquoteScalar(cleaned);
}

/**
 * Minimal, dependency-free YAML frontmatter parser.
 * Supports scalars (string/number/boolean), inline arrays [a, b],
 * comma-separated strings, and block lists (- item).
 */
export function parseFrontmatter(content) {
  const text = String(content ?? '').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { frontmatter: null, body: text.trim() };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === '---' || trimmed === '...') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: null, body: text.trim() };
  }

  const fmLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join('\n').trim();
  const data = {};
  let activeListKey = null;

  for (const rawLine of fmLines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // YAML block sequence item: "  - value"
    const listMatch = rawLine.match(/^\s*-\s+(.*)$/);
    if (listMatch && activeListKey) {
      const val = unquoteScalar(stripInlineComment(listMatch[1]));
      if (val !== '') {
        if (!Array.isArray(data[activeListKey])) data[activeListKey] = [];
        data[activeListKey].push(val);
      }
      continue;
    }

    const kvMatch = rawLine.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      activeListKey = null;
      continue;
    }

    const key = kvMatch[1].trim().toLowerCase();
    const rest = kvMatch[2].trim();

    if (rest === '') {
      data[key] = [];
      activeListKey = key;
    } else {
      data[key] = parseScalarValue(rest);
      activeListKey = null;
    }
  }

  return { frontmatter: data, body };
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => (typeof item === 'string' ? splitInlineList(item) : [String(item)]))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    return splitInlineList(value)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function readCachedFile(absPath) {
  const st = statSync(absPath);
  const cached = fileCache.get(absPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }

  const raw = readFileSync(absPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    raw,
    frontmatter,
    body,
  };
  fileCache.set(absPath, entry);
  return entry;
}

function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('^$.|+()[]{}\\'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  re += '$';
  return new RegExp(re);
}

function matchesPathPattern(candidateRelPosix, pattern) {
  const candidate = stripLeadingDotSlash(candidateRelPosix);
  const pat = stripLeadingDotSlash(pattern);
  if (!candidate || !pat) return false;

  const isGlob = pat.includes('*') || pat.includes('?');
  if (isGlob) {
    const regex = globToRegExp(pat);
    if (regex.test(candidate)) return true;
    // Patterns without a slash (e.g. "*.css") also match the file basename at any depth
    if (!pat.includes('/')) {
      const base = candidate.includes('/') ? candidate.slice(candidate.lastIndexOf('/') + 1) : candidate;
      if (regex.test(base)) return true;
    }
    return false;
  }

  // Substring / prefix match
  const trimmedPat = pat.endsWith('/') ? pat.slice(0, -1) : pat;
  if (candidate === trimmedPat) return true;
  if (candidate.startsWith(`${trimmedPat}/`)) return true;
  if (pat.endsWith('/') && candidate.includes(`/${trimmedPat}/`)) return true;
  if (!pat.includes('/')) {
    const segments = candidate.split('/');
    if (segments.includes(trimmedPat)) return true;
  }
  return candidate.includes(pat);
}

function normalizeActivePaths(cwd, activePaths) {
  const resolvedCwd = resolve(cwd);
  const seen = new Set();
  const normalized = [];

  for (const input of activePaths ?? []) {
    if (typeof input !== 'string' || !input.trim()) continue;
    const trimmed = input.trim();
    const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(resolvedCwd, trimmed);
    const relRaw = relative(resolvedCwd, abs);
    const insideCwd =
      relRaw === '' || (!relRaw.startsWith('..') && !isAbsolute(relRaw));
    const relPosix = insideCwd ? stripLeadingDotSlash(relRaw) : stripLeadingDotSlash(trimmed);

    const key = `${abs}::${relPosix}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      raw: trimmed,
      abs,
      relPosix,
      insideCwd,
    });
  }

  normalized.sort((a, b) => compareCodeUnits(a.relPosix, b.relPosix));
  return normalized;
}

function discoverFootguns(resolvedCwd, normalizedPaths) {
  /** @type {Map<string, { depth: number, dirRel: string, filePath: string, fileName: string, relSource: string }>} */
  const found = new Map();

  for (const item of normalizedPaths) {
    if (!item.insideCwd) continue;

    let startDir = item.abs;
    if (existsSync(item.abs)) {
      try {
        if (!statSync(item.abs).isDirectory()) {
          startDir = dirname(item.abs);
        }
      } catch {
        startDir = dirname(item.abs);
      }
    } else if (!item.raw.endsWith('/') && !item.raw.endsWith('\\')) {
      startDir = dirname(item.abs);
    }

    // Collect chain from startDir upward to resolvedCwd
    const chain = [];
    let curr = startDir;
    while (true) {
      const rel = relative(resolvedCwd, curr);
      if (rel.startsWith('..') || isAbsolute(rel)) break;
      chain.push({ absDir: curr, dirRel: stripLeadingDotSlash(rel) });
      if (curr === resolvedCwd) break;
      const parent = dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }

    // Reverse to parent-to-child order
    chain.reverse();

    for (let depth = 0; depth < chain.length; depth += 1) {
      const { absDir, dirRel } = chain[depth];
      for (const fileName of FOOTGUN_FILENAMES) {
        const candidate = join(absDir, fileName);
        if (!existsSync(candidate)) continue;
        try {
          if (!statSync(candidate).isFile()) continue;
        } catch {
          continue;
        }
        const relSource = dirRel ? `${dirRel}/${fileName}` : fileName;
        if (!found.has(relSource)) {
          found.set(relSource, {
            depth,
            dirRel,
            filePath: candidate,
            fileName,
            relSource,
          });
        }
      }
    }
  }

  const ordered = Array.from(found.values()).sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const dirCmp = compareCodeUnits(a.dirRel, b.dirRel);
    if (dirCmp !== 0) return dirCmp;
    return compareCodeUnits(a.fileName, b.fileName);
  });

  const rules = [];
  for (const item of ordered) {
    const cached = readCachedFile(item.filePath);
    const text = (cached.frontmatter ? cached.body : cached.raw).trim();
    if (!text) continue;
    const name =
      (cached.frontmatter && typeof cached.frontmatter.name === 'string' && cached.frontmatter.name) ||
      (item.dirRel ? `footguns:${item.dirRel}` : 'footguns:root');
    const priority =
      cached.frontmatter && typeof cached.frontmatter.priority === 'number'
        ? cached.frontmatter.priority
        : 0;

    rules.push({
      id: `footgun:${item.relSource}`,
      source: item.relSource,
      name,
      reason: item.dirRel ? `activePath ancestor ${item.dirRel}` : 'workspace root footguns',
      text,
      _priority: priority,
      _group: 0,
      _depth: item.depth,
    });
  }

  return rules;
}

function discoverConditionalRuleFiles(resolvedCwd, { goal = '', normalizedPaths = [], recentTools = [] }) {
  const rulesDir = join(resolvedCwd, '.jev', 'rules');
  if (!existsSync(rulesDir)) return [];

  let entries;
  try {
    entries = readdirSync(rulesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const mdFiles = entries
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
    .map((d) => d.name)
    .sort(compareCodeUnits);

  const goalLower = String(goal ?? '').toLowerCase();
  const toolsLowerSet = new Set(
    (recentTools ?? [])
      .filter((t) => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim().toLowerCase())
  );

  const activated = [];

  for (const fileName of mdFiles) {
    const absPath = join(rulesDir, fileName);
    const cached = readCachedFile(absPath);
    const fm = cached.frontmatter;
    if (!fm) continue;

    const text = cached.body.trim();
    if (!text) continue;

    const always = fm.always === true;
    const pathPatterns = normalizeStringList(fm.paths);
    const keywords = normalizeStringList(fm.keywords);
    const tools = normalizeStringList(fm.tools);

    const reasons = [];

    if (always) {
      reasons.push('always');
    }

    if (pathPatterns.length > 0 && normalizedPaths.length > 0) {
      const matchedPatterns = [];
      for (const pat of pathPatterns) {
        if (normalizedPaths.some((p) => matchesPathPattern(p.relPosix, pat))) {
          matchedPatterns.push(pat);
        }
      }
      if (matchedPatterns.length > 0) {
        matchedPatterns.sort(compareCodeUnits);
        reasons.push(`paths:${matchedPatterns.join(',')}`);
      }
    }

    if (keywords.length > 0 && goalLower.length > 0) {
      const matchedKeywords = [];
      for (const kw of keywords) {
        if (goalLower.includes(kw.toLowerCase())) {
          matchedKeywords.push(kw);
        }
      }
      if (matchedKeywords.length > 0) {
        matchedKeywords.sort(compareCodeUnits);
        reasons.push(`keywords:${matchedKeywords.join(',')}`);
      }
    }

    if (tools.length > 0 && toolsLowerSet.size > 0) {
      const matchedTools = [];
      for (const toolPat of tools) {
        const lower = toolPat.toLowerCase();
        if (lower.includes('*') || lower.includes('?')) {
          const re = globToRegExp(lower);
          for (const activeTool of toolsLowerSet) {
            if (re.test(activeTool)) {
              matchedTools.push(toolPat);
              break;
            }
          }
        } else if (toolsLowerSet.has(lower)) {
          matchedTools.push(toolPat);
        }
      }
      if (matchedTools.length > 0) {
        matchedTools.sort(compareCodeUnits);
        reasons.push(`tools:${matchedTools.join(',')}`);
      }
    }

    if (reasons.length === 0) continue;

    const defaultName = basename(fileName, '.md');
    const name =
      typeof fm.name === 'string' && fm.name.trim().length > 0 ? fm.name.trim() : defaultName;
    const priority = typeof fm.priority === 'number' && Number.isFinite(fm.priority) ? fm.priority : 0;
    const relSource = `.jev/rules/${fileName}`;

    activated.push({
      id: `rule:${relSource}`,
      source: relSource,
      name,
      reason: reasons.join('; '),
      text,
      _priority: priority,
      _group: 1,
      _depth: 0,
    });
  }

  return activated;
}

function sliceUtf8Bytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  const buf = Buffer.from(text, 'utf8');
  let end = Math.min(maxBytes, buf.length);
  // Avoid splitting a multi-byte UTF-8 sequence
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Load condition-bound instructions immune to compaction (§VIII).
 *
 * @param {object} params
 * @param {string} params.cwd
 * @param {string} [params.goal]
 * @param {string[]} [params.activePaths]
 * @param {string[]} [params.recentTools]
 * @param {number} [params.maxBytes]
 */
export function loadConditionalRules({
  cwd,
  goal = '',
  activePaths = [],
  recentTools = [],
  maxBytes = 4096,
} = {}) {
  const resolvedCwd = resolve(cwd ?? process.cwd());
  const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 4096;
  const normalizedPaths = normalizeActivePaths(resolvedCwd, activePaths);

  const footgunRules = discoverFootguns(resolvedCwd, normalizedPaths);
  const conditionalRules = discoverConditionalRuleFiles(resolvedCwd, {
    goal,
    normalizedPaths,
    recentTools,
  });

  // Strict deterministic ordering:
  // 1) Higher priority first
  // 2) Within equal priority: footguns (parent-to-child by depth, then source) before/distinct from rules (by id)
  const combined = [...footgunRules, ...conditionalRules].sort((a, b) => {
    if (b._priority !== a._priority) return b._priority - a._priority;
    if (a._group !== b._group) return a._group - b._group;
    if (a._depth !== b._depth) return a._depth - b._depth;
    return compareCodeUnits(a.id, b.id);
  });

  if (combined.length === 0) {
    return {
      rules: [],
      rendered: '',
      totalBytes: 0,
    };
  }

  const header = '[JeV Conditional Rules · deterministic]';
  const headerBytes = Buffer.byteLength(header, 'utf8');
  const selectedRules = [];
  const blocks = [];
  let usedBytes = headerBytes;

  for (const rule of combined) {
    const block = `### ${rule.name} (${rule.source} · ${rule.reason})\n${rule.text}`;
    const sepBytes = 2; // "\n\n"
    const blockBytes = Buffer.byteLength(block, 'utf8');

    if (usedBytes + sepBytes + blockBytes <= budget) {
      blocks.push(block);
      usedBytes += sepBytes + blockBytes;
      selectedRules.push({
        id: rule.id,
        source: rule.source,
        name: rule.name,
        reason: rule.reason,
        text: rule.text,
      });
    } else {
      const ruleHead = `### ${rule.name} (${rule.source} · ${rule.reason})\n`;
      const suffix = '\n[...truncated by maxBytes]';
      const overhead = sepBytes + Buffer.byteLength(ruleHead, 'utf8') + Buffer.byteLength(suffix, 'utf8');
      const availForText = budget - usedBytes - overhead;
      if (availForText >= 24) {
        const clippedText = sliceUtf8Bytes(rule.text, availForText);
        const clippedBlock = `${ruleHead}${clippedText}${suffix}`;
        blocks.push(clippedBlock);
        usedBytes += sepBytes + Buffer.byteLength(clippedBlock, 'utf8');
        selectedRules.push({
          id: rule.id,
          source: rule.source,
          name: rule.name,
          reason: rule.reason,
          text: clippedText,
        });
      }
      break;
    }
  }

  if (selectedRules.length === 0) {
    return {
      rules: [],
      rendered: '',
      totalBytes: 0,
    };
  }

  const rendered = [header, ...blocks].join('\n\n');
  const totalBytes = Buffer.byteLength(rendered, 'utf8');

  return {
    rules: selectedRules,
    rendered,
    totalBytes,
  };
}
