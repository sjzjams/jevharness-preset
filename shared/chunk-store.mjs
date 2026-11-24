import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHUNK_KINDS = Object.freeze([
  'tool_output',
  'file_read',
  'search_result',
  'command_output',
  'repo_fact',
  'subagent_result',
  'user_turn',
]);

export const CHUNK_ACCESS = Object.freeze(['read', 'write']);

export const SENSITIVITY_LEVELS = Object.freeze([
  'public',
  'internal',
  'sensitive',
  'secret',
]);

export const VISIBILITY_LEVELS = Object.freeze([
  'hide',
  'short_summary',
  'long_summary',
  'full',
]);

export const SENSITIVITY_RANK = Object.freeze({
  public: 0,
  internal: 1,
  sensitive: 2,
  secret: 3,
});

const VISIBILITY_PRIORITY = Object.freeze({
  full: 3,
  long_summary: 2,
  short_summary: 1,
  hide: 0,
});

const CRITICAL_KINDS = new Set(['user_turn', 'repo_fact']);
const SHORT_SUMMARY_LIMIT = 240;
const LONG_SUMMARY_LIMIT = 1200;

const SALIENT_LINE_RE =
  /(?:error|fail|failed|exception|warn|warning|todo|fixme|exports+(?:defaults+)?(?:asyncs+)?(?:function|class|const|let|var)|^s*(?:function|class|def|fn|pubs+fn|interface|type)s+|:d+:|PASS|FAIL|assert|throws+)/i;

function assertEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new RangeError(
      `Invalid ${fieldName}: ${JSON.stringify(value)}. Expected one of: ${allowed.join(', ')}`
    );
  }
  return value;
}

function countLines(text) {
  if (!text) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars));
  return text.slice(0, maxChars - 1) + '…';
}

function collapseSpaces(line) {
  return line.replace(/\s+/g, ' ').trim();
}

function buildShortSummary(text, { source = '', lines = 0, chars = 0 } = {}) {
  const rawLines = text ? text.split(/\r?\n/) : [];
  const nonEmpty = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const cleaned = collapseSpaces(rawLines[i]);
    if (cleaned) nonEmpty.push({ idx: i + 1, text: cleaned });
  }

  const stats = `[${lines}L/${chars}c]`;
  const first = nonEmpty[0]?.text ?? '(empty)';

  // Find a salient hit that differs from the first line
  let hit = '';
  for (let i = 1; i < nonEmpty.length; i += 1) {
    if (SALIENT_LINE_RE.test(nonEmpty[i].text)) {
      hit = `L${nonEmpty[i].idx}: ${nonEmpty[i].text}`;
      break;
    }
  }

  const parts = [];
  if (source) parts.push(source);
  parts.push(stats);
  parts.push(first);
  if (hit && hit !== first) {
    parts.push(`| ${hit}`);
  }

  return truncateText(parts.join(' '), SHORT_SUMMARY_LIMIT);
}

function buildLongSummary(text) {
  if (!text) return '(empty)';
  if (text.length <= LONG_SUMMARY_LIMIT) return text;

  const rawLines = text.split(/\r?\n/);
  const totalLines = rawLines.length;

  // Single very long line fallback: head + tail sampling
  if (totalLines <= 3) {
    const marker = `\n... [${text.length - (LONG_SUMMARY_LIMIT - 40)} chars omitted] ...\n`;
    const budget = Math.max(20, LONG_SUMMARY_LIMIT - marker.length);
    const headLen = Math.ceil(budget * 0.65);
    const tailLen = Math.max(0, budget - headLen);
    return truncateText(text.slice(0, headLen) + marker + text.slice(text.length - tailLen), LONG_SUMMARY_LIMIT);
  }

  const headCount = Math.min(6, Math.ceil(totalLines * 0.25));
  const tailCount = Math.min(4, Math.max(2, Math.floor(totalLines * 0.15)));
  const selected = new Set();

  for (let i = 0; i < headCount && i < totalLines; i += 1) {
    selected.add(i);
  }

  // Extract salient lines from the middle
  const middleEnd = Math.max(headCount, totalLines - tailCount);
  let salientAdded = 0;
  for (let i = headCount; i < middleEnd && salientAdded < 8; i += 1) {
    if (SALIENT_LINE_RE.test(rawLines[i])) {
      selected.add(i);
      salientAdded += 1;
    }
  }

  for (let i = Math.max(headCount, totalLines - tailCount); i < totalLines; i += 1) {
    selected.add(i);
  }

  const orderedIndices = Array.from(selected).sort((a, b) => a - b);
  const out = [];
  let prev = -1;
  for (const idx of orderedIndices) {
    if (prev !== -1 && idx > prev + 1) {
      out.push(`... [${idx - prev - 1} lines omitted] ...`);
    }
    out.push(truncateText(rawLines[idx], 220));
    prev = idx;
  }

  let joined = out.join('\n');
  if (joined.length <= LONG_SUMMARY_LIMIT) return joined;

  // Tightly pack head + tail within LONG_SUMMARY_LIMIT
  const marker = `\n... [${totalLines}L/${text.length}c truncated] ...\n`;
  const budget = Math.max(20, LONG_SUMMARY_LIMIT - marker.length);
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  const headPart = joined.slice(0, headBudget);
  const tailPart = joined.slice(joined.length - tailBudget);
  return truncateText(headPart + marker + tailPart, LONG_SUMMARY_LIMIT);
}

function sanitizeSessionFileName(sessionId) {
  const safe = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_');
  const suffix = sha256(String(sessionId)).slice(0, 8);
  return `${safe.slice(0, 48)}_${suffix}.json`;
}

function toPublicChunk(entry) {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    kind: entry.kind,
    access: entry.access,
    sensitivity: entry.sensitivity,
    source: entry.source,
    chars: entry.chars,
    lines: entry.lines,
    createdAt: entry.createdAt,
    turn: entry.turn,
    step: entry.step,
    visibility: entry.visibility,
    shortSummary: entry.shortSummary,
    longSummary: entry.longSummary,
    fullText: entry.fullText,
  };
}

function toMetadata(entry) {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    kind: entry.kind,
    access: entry.access,
    sensitivity: entry.sensitivity,
    source: entry.source,
    chars: entry.chars,
    lines: entry.lines,
    createdAt: entry.createdAt,
    turn: entry.turn,
    step: entry.step,
    visibility: entry.visibility,
    shortSummary: entry.shortSummary,
  };
}

/**
 * Create an explicit typed chunk store aligned with:
 * - §I Explicit typed state
 * - §V Visibility ladder (compress, never delete)
 * - §X Shared retrieval pack
 */
export function createChunkStore(options = {}) {
  const maxChunksPerSession =
    Number.isInteger(options.maxChunksPerSession) && options.maxChunksPerSession > 0
      ? options.maxChunksPerSession
      : 64;
  const maxFullCharsPerChunk =
    Number.isInteger(options.maxFullCharsPerChunk) && options.maxFullCharsPerChunk > 0
      ? options.maxFullCharsPerChunk
      : 120000;
  const persistDir = typeof options.persistDir === 'string' && options.persistDir.length > 0
    ? options.persistDir
    : null;

  /** @type {Map<string, { nextId: number, accessSeq: number, evictedCount: number, chunks: Map<string, any>, dedupIndex: Map<string, string> }>} */
  const sessions = new Map();

  function getPersistPath(sessionId) {
    if (!persistDir) return null;
    return join(persistDir, sanitizeSessionFileName(sessionId));
  }

  function loadSessionFromDisk(sessionId) {
    const filePath = getPersistPath(sessionId);
    if (!filePath || !existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      const state = {
        nextId: Number.isInteger(parsed.nextId) && parsed.nextId > 0 ? parsed.nextId : 1,
        accessSeq: Number.isInteger(parsed.accessSeq) ? parsed.accessSeq : 0,
        evictedCount: Number.isInteger(parsed.evictedCount) ? parsed.evictedCount : 0,
        chunks: new Map(),
        dedupIndex: new Map(),
      };
      if (Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          state.chunks.set(entry.id, entry);
          if (entry._dedupKey) {
            state.dedupIndex.set(entry._dedupKey, entry.id);
          }
        }
      }
      return state;
    } catch {
      return null;
    }
  }

  function saveSessionToDisk(sessionId, state) {
    const filePath = getPersistPath(sessionId);
    if (!filePath) return;
    mkdirSync(persistDir, { recursive: true });
    const payload = JSON.stringify({
      sessionId,
      nextId: state.nextId,
      accessSeq: state.accessSeq,
      evictedCount: state.evictedCount,
      entries: Array.from(state.chunks.values()),
    });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, payload, 'utf8');
    renameSync(tmpPath, filePath);
  }

  function getOrCreateSession(sessionId) {
    const sid = String(sessionId ?? 'default');
    let state = sessions.get(sid);
    if (!state) {
      state = loadSessionFromDisk(sid) ?? {
        nextId: 1,
        accessSeq: 0,
        evictedCount: 0,
        chunks: new Map(),
        dedupIndex: new Map(),
      };
      sessions.set(sid, state);
    }
    return state;
  }

  function touch(state, entry) {
    state.accessSeq += 1;
    entry._lastAccess = state.accessSeq;
  }

  function evictIfNeeded(state) {
    while (state.chunks.size > maxChunksPerSession) {
      let victim = null;
      for (const entry of state.chunks.values()) {
        if (entry.visibility !== 'hide') continue;
        if (entry._critical || CRITICAL_KINDS.has(entry.kind)) continue;
        if (!victim || entry._lastAccess < victim._lastAccess) {
          victim = entry;
        }
      }
      if (!victim) {
        // Compress, never delete: never evict visible or critical chunks.
        break;
      }
      state.chunks.delete(victim.id);
      if (victim._dedupKey && state.dedupIndex.get(victim._dedupKey) === victim.id) {
        state.dedupIndex.delete(victim._dedupKey);
      }
      state.evictedCount += 1;
    }
  }

  function addChunk(sessionId, input = {}) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);

    const kind = assertEnum(input.kind ?? 'tool_output', CHUNK_KINDS, 'kind');
    const access = assertEnum(input.access ?? 'read', CHUNK_ACCESS, 'access');
    const sensitivity = assertEnum(input.sensitivity ?? 'internal', SENSITIVITY_LEVELS, 'sensitivity');
    const visibility = assertEnum(input.visibility ?? 'short_summary', VISIBILITY_LEVELS, 'visibility');
    const source = String(input.source ?? '');

    const rawText = String(input.fullText ?? input.text ?? '');
    let fullText = rawText;
    if (rawText.length > maxFullCharsPerChunk) {
      const marker = `\n[...truncated from ${rawText.length} to ${maxFullCharsPerChunk} chars]`;
      const keep = Math.max(0, maxFullCharsPerChunk - marker.length);
      fullText = rawText.slice(0, keep) + marker.slice(0, maxFullCharsPerChunk - keep);
    }

    const contentHash = sha256(fullText);
    const dedupKey = `${sid}::${source}::${contentHash}`;

    const existingId = state.dedupIndex.get(dedupKey);
    if (existingId && state.chunks.has(existingId)) {
      const existing = state.chunks.get(existingId);
      touch(state, existing);
      saveSessionToDisk(sid, state);
      return toPublicChunk(existing);
    }

    const chars = fullText.length;
    const lines = countLines(fullText);
    const shortSummary =
      typeof input.shortSummary === 'string' && input.shortSummary.length > 0
        ? truncateText(input.shortSummary, SHORT_SUMMARY_LIMIT)
        : buildShortSummary(fullText, { source, lines, chars });
    const longSummary =
      typeof input.longSummary === 'string' && input.longSummary.length > 0
        ? truncateText(input.longSummary, LONG_SUMMARY_LIMIT)
        : buildLongSummary(fullText);

    const id = `c${state.nextId}`;
    state.nextId += 1;
    state.accessSeq += 1;

    const entry = {
      id,
      sessionId: sid,
      kind,
      access,
      sensitivity,
      source,
      chars,
      lines,
      createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
      turn: Number.isInteger(input.turn) ? input.turn : 0,
      step: Number.isInteger(input.step) ? input.step : 0,
      visibility,
      shortSummary,
      longSummary,
      fullText,
      _dedupKey: dedupKey,
      _contentHash: contentHash,
      _lastAccess: state.accessSeq,
      _critical: Boolean(input.critical) || CRITICAL_KINDS.has(kind),
    };

    state.chunks.set(id, entry);
    state.dedupIndex.set(dedupKey, id);
    evictIfNeeded(state);
    saveSessionToDisk(sid, state);

    return toPublicChunk(entry);
  }

  function getChunk(sessionId, id) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const entry = state.chunks.get(String(id));
    if (!entry) return null;
    touch(state, entry);
    return toPublicChunk(entry);
  }

  function readChunk(sessionId, id, opts = {}) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const entry = state.chunks.get(String(id));
    if (!entry) return null;

    const level = assertEnum(opts.level ?? 'full', VISIBILITY_LEVELS, 'level');
    const offset = Number.isInteger(opts.offset) && opts.offset >= 0 ? opts.offset : 0;
    const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 4000;

    touch(state, entry);

    let sourceText = '';
    if (level === 'full') sourceText = entry.fullText;
    else if (level === 'long_summary') sourceText = entry.longSummary;
    else if (level === 'short_summary') sourceText = entry.shortSummary;
    else sourceText = '';

    const totalChars = sourceText.length;
    const text = sourceText.slice(offset, offset + limit);
    const hasMore = offset + text.length < totalChars;

    return {
      id: entry.id,
      sessionId: entry.sessionId,
      kind: entry.kind,
      access: entry.access,
      sensitivity: entry.sensitivity,
      source: entry.source,
      visibility: entry.visibility,
      level,
      offset,
      limit,
      totalChars,
      returnedChars: text.length,
      truncated: hasMore,
      hasMore,
      nextOffset: hasMore ? offset + text.length : null,
      lines: entry.lines,
      text,
    };
  }

  function listMetadata(sessionId, opts = {}) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const limit = Number.isInteger(opts.limit) && opts.limit >= 0 ? opts.limit : 12;
    const all = Array.from(state.chunks.values());
    const sliced = limit === 0 ? [] : all.slice(-limit);
    return sliced.map(toMetadata);
  }

  function applyVisibility(sessionId, visMap) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const updated = [];
    const skipped = [];

    const pairs = [];
    if (visMap instanceof Map) {
      for (const [k, v] of visMap.entries()) pairs.push([k, v]);
    } else if (Array.isArray(visMap)) {
      for (const item of visMap) {
        if (item && typeof item.id === 'string') {
          pairs.push([item.id, item.visibility]);
        }
      }
    } else if (visMap && typeof visMap === 'object') {
      for (const [k, v] of Object.entries(visMap)) pairs.push([k, v]);
    }

    for (const [id, vis] of pairs) {
      const entry = state.chunks.get(String(id));
      if (!entry) {
        skipped.push({ id: String(id), reason: 'not_found' });
        continue;
      }
      if (!VISIBILITY_LEVELS.includes(vis)) {
        skipped.push({ id: String(id), reason: 'invalid_visibility' });
        continue;
      }
      entry.visibility = vis;
      touch(state, entry);
      updated.push(entry.id);
    }

    evictIfNeeded(state);
    saveSessionToDisk(sid, state);
    return { updated, skipped };
  }

  function renderDigest(sessionId, opts = {}) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const maxChars = Number.isInteger(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 2400;
    const all = Array.from(state.chunks.values());

    if (all.length === 0) {
      return '';
    }

    const hidden = [];
    const visible = [];
    for (const entry of all) {
      if (entry.visibility === 'hide') hidden.push(entry);
      else visible.push(entry);
    }

    const headerLines = [
      `[Chunk Index · session=${sid} · total=${all.length} · visible=${visible.length} · hidden=${hidden.length}]`,
    ];
    if (hidden.length > 0) {
      const hiddenIds = hidden.map((h) => h.id).join(', ');
      headerLines.push(
        `Hidden (recallable via jev_chunk_read, not deleted): ${hidden.length} [${hiddenIds}]`
      );
    }
    const footer = 'Tip: call jev_chunk_read({ chunk_id, level: "full" | "long_summary", offset, limit }) to inspect any chunk.';

    const header = headerLines.join('\n');
    const reserved = header.length + footer.length + 4;
    if (reserved >= maxChars) {
      return truncateText(`${header}\n${footer}`, maxChars);
    }

    let remaining = maxChars - reserved;
    const bodyLines = [];
    let omittedVisible = 0;

    for (const entry of visible) {
      const metaHead = `- ${entry.id} [${entry.kind}|${entry.access}|${entry.sensitivity}|${entry.visibility}] ${entry.source || '(unnamed)'} (${entry.lines}L/${entry.chars}c)`;
      let content = '';
      if (entry.sensitivity === 'secret') {
        content = '[SECRET redacted from digest]';
      } else if (entry.visibility === 'full') {
        content = entry.fullText;
      } else if (entry.visibility === 'long_summary') {
        content = entry.longSummary;
      } else {
        content = entry.shortSummary;
      }

      const block = `${metaHead}\n  ${content.replace(/\r?\n/g, '\n  ')}`;
      const needed = block.length + 1;
      if (needed <= remaining) {
        bodyLines.push(block);
        remaining -= needed;
      } else if (remaining > metaHead.length + 24) {
        const clipped = truncateText(block, remaining - 1);
        bodyLines.push(clipped);
        remaining = 0;
      } else {
        omittedVisible += 1;
      }
    }

    if (omittedVisible > 0) {
      const note = `... (+${omittedVisible} visible chunk(s) omitted by budget; use jev_chunk_read)`;
      if (note.length + 1 <= remaining) {
        bodyLines.push(note);
      }
    }

    const sections = [header];
    if (bodyLines.length > 0) sections.push(bodyLines.join('\n'));
    sections.push(footer);

    return truncateText(sections.join('\n'), maxChars);
  }

  function exportRetrievalPack(sessionId, opts = {}) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const maxSensitivity = assertEnum(
      opts.maxSensitivity ?? 'internal',
      SENSITIVITY_LEVELS,
      'maxSensitivity'
    );
    const maxChars = Number.isInteger(opts.maxChars) && opts.maxChars > 0 ? opts.maxChars : 6000;
    const maxRank = SENSITIVITY_RANK[maxSensitivity];

    const all = Array.from(state.chunks.values());
    const eligible = [];
    let excludedBySensitivity = 0;

    for (const entry of all) {
      if (SENSITIVITY_RANK[entry.sensitivity] > maxRank) {
        excludedBySensitivity += 1;
        continue;
      }
      eligible.push(entry);
    }

    // Prioritize higher visibility, then most recent chunks, with deterministic ID tie-breaker
    const prioritized = [...eligible].sort((a, b) => {
      const visDiff = VISIBILITY_PRIORITY[b.visibility] - VISIBILITY_PRIORITY[a.visibility];
      if (visDiff !== 0) return visDiff;
      if (b.turn !== a.turn) return b.turn - a.turn;
      if (b.step !== a.step) return b.step - a.step;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const packHeader = `[Shared Read-Only Retrieval Pack · session=${sid} · maxSensitivity=${maxSensitivity}]`;
    let remaining = Math.max(0, maxChars - packHeader.length - 1);
    const includedChunks = [];
    const renderedParts = [packHeader];

    for (const entry of prioritized) {
      if (remaining <= 0) break;

      const label = `## ${entry.id} (${entry.kind} · ${entry.sensitivity} · ${entry.source || 'unnamed'} · ${entry.lines}L/${entry.chars}c)`;
      const candidates =
        entry.visibility === 'full'
          ? [
              ['full', entry.fullText],
              ['long_summary', entry.longSummary],
              ['short_summary', entry.shortSummary],
            ]
          : entry.visibility === 'long_summary'
            ? [
                ['long_summary', entry.longSummary],
                ['short_summary', entry.shortSummary],
              ]
            : [['short_summary', entry.shortSummary]];

      let chosenLevel = null;
      let chosenText = null;
      for (const [lvl, txt] of candidates) {
        const blockLen = label.length + 1 + txt.length + 1;
        if (blockLen <= remaining) {
          chosenLevel = lvl;
          chosenText = txt;
          break;
        }
      }

      if (!chosenText) {
        const minBudget = label.length + 32;
        if (remaining >= minBudget) {
          chosenLevel = 'short_summary';
          chosenText = truncateText(entry.shortSummary, remaining - label.length - 2);
        } else {
          continue;
        }
      }

      const block = `${label}\n${chosenText}`;
      renderedParts.push(block);
      remaining = Math.max(0, remaining - block.length - 1);

      includedChunks.push(
        Object.freeze({
          id: entry.id,
          kind: entry.kind,
          access: entry.access,
          sensitivity: entry.sensitivity,
          source: entry.source,
          chars: entry.chars,
          lines: entry.lines,
          visibility: entry.visibility,
          contentLevel: chosenLevel,
          content: chosenText,
        })
      );
    }

    const rendered = truncateText(renderedParts.join('\n'), maxChars);

    return Object.freeze({
      sessionId: sid,
      readOnly: true,
      maxSensitivity,
      totalChunks: all.length,
      eligibleCount: eligible.length,
      includedCount: includedChunks.length,
      excludedBySensitivity,
      totalChars: rendered.length,
      chunks: Object.freeze(includedChunks),
      rendered,
    });
  }

  function clearSession(sessionId) {
    const sid = String(sessionId ?? 'default');
    sessions.delete(sid);
    const filePath = getPersistPath(sid);
    if (filePath && existsSync(filePath)) {
      rmSync(filePath, { force: true });
    }
  }

  function stats(sessionId) {
    const sid = String(sessionId ?? 'default');
    const state = getOrCreateSession(sid);
    const byVisibility = { hide: 0, short_summary: 0, long_summary: 0, full: 0 };
    const bySensitivity = { public: 0, internal: 0, sensitive: 0, secret: 0 };
    const byKind = {};
    let totalChars = 0;

    for (const entry of state.chunks.values()) {
      byVisibility[entry.visibility] += 1;
      bySensitivity[entry.sensitivity] += 1;
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      totalChars += entry.chars;
    }

    return {
      sessionId: sid,
      totalChunks: state.chunks.size,
      totalChars,
      byVisibility,
      bySensitivity,
      byKind,
      evictedCount: state.evictedCount,
    };
  }

  return {
    addChunk,
    getChunk,
    readChunk,
    listMetadata,
    applyVisibility,
    renderDigest,
    exportRetrievalPack,
    clearSession,
    stats,
  };
}
