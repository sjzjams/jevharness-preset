const DEFAULT_DEDUP_THRESHOLD = 0.78;
const VALID_ACCESS = new Set(['read', 'write']);
const VALID_COMPLETE_STATUS = new Set(['completed', 'failed', 'cancelled']);

function normalizePath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  let p = rawPath.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!p) return '';

  // Handle Windows drive letter consistently (e.g. C:/foo -> c:/foo)
  let prefix = '';
  if (/^[A-Za-z]:\//.test(p)) {
    prefix = p.slice(0, 2).toLowerCase() + '/';
    p = p.slice(3);
  } else if (p.startsWith('/')) {
    prefix = '/';
    p = p.slice(1);
  }

  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!prefix) {
        parts.push('..');
      }
    } else {
      parts.push(seg);
    }
  }

  if (parts.length === 0) {
    return prefix || '.';
  }
  return prefix + parts.join('/');
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  const unique = new Set();
  for (const p of paths) {
    const norm = normalizePath(p);
    if (norm) unique.add(norm);
  }
  return Array.from(unique).sort();
}

function pathsOverlap(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const aPrefix = a.endsWith('/') ? a : `${a}/`;
  const bPrefix = b.endsWith('/') ? b : `${b}/`;
  return b.startsWith(aPrefix) || a.startsWith(bPrefix);
}

function findOverlappingPaths(pathsA, pathsB) {
  const overlaps = [];
  for (const a of pathsA) {
    for (const b of pathsB) {
      if (pathsOverlap(a, b)) {
        overlaps.push(a === b ? a : `${a} <-> ${b}`);
      }
    }
  }
  return overlaps;
}

/**
 * Normalize text and extract tokens supporting both English/alphanumeric words
 * and CJK characters for deterministic Jaccard similarity.
 */
export function tokenizeText(text) {
  const normalized = String(text ?? '')
    .normalize('NFKC')
    .toLowerCase();

  const tokens = new Set();
  // Match ASCII/Unicode Latin/digit words OR individual CJK ideographs / Kana / Hangul
  const matches = normalized.match(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  if (!matches) return tokens;

  for (const tok of matches) {
    tokens.add(tok);
  }
  return tokens;
}

export function jaccardSimilarity(tokensA, tokensB) {
  if (tokensA.size === 0 && tokensB.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
  for (const tok of smaller) {
    if (larger.has(tok)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function buildSignatureTokens({ description = '', prompt = '', paths = [] }) {
  const combined = [description, prompt, ...paths].filter(Boolean).join(' ');
  return tokenizeText(combined);
}

function toPublicSubgoal(entry) {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    description: entry.description,
    prompt: entry.prompt,
    access: entry.access,
    paths: [...entry.paths],
    status: entry.status,
    summary: entry.summary,
    createdAt: entry.createdAt,
    completedAt: entry.completedAt,
  };
}

/**
 * Create a subgoal tracker aligned with:
 * - §VI.A Concurrent read/write path locking
 * - §VI.B Subgoal deduplication (in_flight & completed)
 */
export function createSubgoalTracker(options = {}) {
  const dedupThreshold =
    typeof options.dedupThreshold === 'number' &&
    options.dedupThreshold > 0 &&
    options.dedupThreshold <= 1
      ? options.dedupThreshold
      : DEFAULT_DEDUP_THRESHOLD;
  // Optional stale in-flight TTL. A completion event can be lost (tool error,
  // aborted call, async activation with no follow-up); without a TTL that
  // subgoal latches as in_flight forever and permanently blocks duplicates and
  // overlapping writes — a gate-error feedback self-lock. 0 disables the TTL.
  const inFlightTtlMs =
    typeof options.inFlightTtlMs === 'number' && options.inFlightTtlMs >= 0
      ? options.inFlightTtlMs
      : 0;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  function isExpiredInFlight(entry) {
    if (inFlightTtlMs <= 0) return false;
    if (entry.status !== 'in_flight') return false;
    const ts = typeof entry.createdAt === 'number' ? entry.createdAt : 0;
    return now() - ts > inFlightTtlMs;
  }

  /** @type {Map<string, { nextId: number, subgoals: Map<string, any> }>} */
  const sessions = new Map();

  function getOrCreateSession(sessionId) {
    const sid = String(sessionId ?? 'default');
    let state = sessions.get(sid);
    if (!state) {
      state = {
        nextId: 1,
        subgoals: new Map(),
      };
      sessions.set(sid, state);
    }
    return state;
  }

  function checkDuplicate(sessionId, input = {}) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const description = String(input.description ?? '').trim();
    const prompt = String(input.prompt ?? '').trim();
    const paths = normalizePaths(input.paths);
    const candidateTokens = buildSignatureTokens({ description, prompt, paths });

    if (candidateTokens.size === 0) {
      return { duplicate: false };
    }

    let bestMatch = null;
    let bestSim = -1;

    for (const existing of state.subgoals.values()) {
      if (existing.status !== 'in_flight' && existing.status !== 'completed') {
        continue;
      }
      // A stale in-flight subgoal no longer blocks new work (lost completion).
      if (isExpiredInFlight(existing)) {
        continue;
      }

      // If both declare explicit target paths and they are completely disjoint,
      // treat them as distinct subgoals operating on separate targets.
      if (paths.length > 0 && existing.paths.length > 0) {
        const overlaps = findOverlappingPaths(paths, existing.paths);
        if (overlaps.length === 0) {
          continue;
        }
      }

      const sim = jaccardSimilarity(candidateTokens, existing._tokens);
      if (sim < dedupThreshold) continue;

      const isBetter =
        sim > bestSim ||
        (sim === bestSim && existing.status === 'in_flight' && bestMatch?.status !== 'in_flight');

      if (isBetter) {
        bestSim = sim;
        bestMatch = existing;
      }
    }

    if (!bestMatch) {
      return { duplicate: false };
    }

    return {
      duplicate: true,
      status: bestMatch.status,
      existing: toPublicSubgoal(bestMatch),
      similarity: Number(bestSim.toFixed(4)),
    };
  }

  function findLockConflicts(state, access, paths, excludeId = null) {
    if (paths.length === 0) return [];
    const holders = [];

    for (const existing of state.subgoals.values()) {
      if (existing.status !== 'in_flight') continue;
      if (isExpiredInFlight(existing)) continue;
      if (excludeId && existing.id === excludeId) continue;
      if (existing.paths.length === 0) continue;

      // Read-Read never conflicts; Write-Write and Read-Write / Write-Read conflict on overlapping paths
      if (access === 'read' && existing.access === 'read') continue;

      const conflictingPaths = findOverlappingPaths(paths, existing.paths);
      if (conflictingPaths.length > 0) {
        holders.push({
          id: existing.id,
          access: existing.access,
          description: existing.description,
          paths: [...existing.paths],
          conflictingPaths,
        });
      }
    }

    return holders;
  }

  function registerSubgoal(sessionId, input = {}) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);

    const access = input.access ?? 'read';
    if (!VALID_ACCESS.has(access)) {
      throw new RangeError(`Invalid access: ${JSON.stringify(access)}. Expected 'read' or 'write'.`);
    }

    const description = String(input.description ?? '').trim();
    const prompt = String(input.prompt ?? '').trim();
    const paths = normalizePaths(input.paths);
    const id =
      typeof input.id === 'string' && input.id.trim().length > 0
        ? input.id.trim()
        : `sg${state.nextId++}`;

    const holders = findLockConflicts(state, access, paths, id);
    if (holders.length > 0) {
      return {
        registered: false,
        conflict: true,
        holders,
      };
    }

    const entry = {
      id,
      sessionId: sid,
      description,
      prompt,
      access,
      paths,
      status: 'in_flight',
      summary: '',
      createdAt: typeof input.createdAt === 'number' ? input.createdAt : now(),
      completedAt: null,
      _tokens: buildSignatureTokens({ description, prompt, paths }),
    };

    state.subgoals.set(id, entry);

    return {
      registered: true,
      conflict: false,
      subgoal: toPublicSubgoal(entry),
    };
  }

  function completeSubgoal(sessionId, id, input = {}) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const entry = state.subgoals.get(String(id));
    if (!entry) return null;

    const status = input.status ?? 'completed';
    if (!VALID_COMPLETE_STATUS.has(status)) {
      throw new RangeError(
        `Invalid completion status: ${JSON.stringify(status)}. Expected one of: completed, failed, cancelled.`
      );
    }

    entry.status = status;
    entry.summary = typeof input.summary === 'string' ? input.summary : entry.summary;
    entry.completedAt = typeof input.completedAt === 'number' ? input.completedAt : Date.now();

    return toPublicSubgoal(entry);
  }

  function listSubgoals(sessionId) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    return Array.from(state.subgoals.values()).map(toPublicSubgoal);
  }

  function clearSession(sessionId) {
    const sid = String(sessionId ?? 'default');
    sessions.delete(sid);
  }

  return {
    checkDuplicate,
    registerSubgoal,
    completeSubgoal,
    listSubgoals,
    clearSession,
  };
}
