/**
 * Repair legacy JeV session logs that contain bare jev/* session events.
 *
 * Earlier jev-harness-loop versions persisted UI events with
 *   session.append('jev/decision' | 'jev/gate' | 'jev/receipt', data)
 * The host session-event vocabulary is CLOSED and only events carrying
 * ignorable:true may be unknown to the reader; a bare jev/* event makes the
 * WHOLE log unreadable on the next open. Nothing is corrupt - the raw log is
 * intact - it just needs those events re-tagged into the host plugin-record
 * namespace with ignorable:true.
 *
 * Rewrites each affected session.v*.jsonl.zstd in place (after a timestamped
 * backup): every jev/<name> record becomes plugin:jev-harness/<name> with
 * ignorable:true; seq/time/data are preserved. Frame container layout is kept.
 *
 * Zero external dependencies. Node >= 22 (zlib zstd).
 */
import { readFileSync, writeFileSync, renameSync, copyFileSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

/** Locate complete Zstandard frames without decompressing blocks. */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid zstd frame magic at byte ' + offset)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit at byte ' + (offset - 1))
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error('reserved block type at byte ' + (offset - 3))
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Decode every complete frame into one concatenated UTF-8 string. */
export function decodeAllFrames(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  const parts = []
  for (const f of frames) parts.push(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)))
  return { text: Buffer.concat(parts).toString('utf8'), frames: frames.length, tornStart }
}

/** Count and collect record types; count bare jev/* events. */
export function analyzeText(text) {
  const lines = text.split('\n').filter((l) => l.length > 0)
  const types = {}
  let jev = 0
  let bad = 0
  for (const l of lines) {
    let o
    try { o = JSON.parse(l) } catch { bad++; continue }
    types[o.type] = (types[o.type] || 0) + 1
    if (typeof o.type === 'string' && o.type.startsWith('jev/')) jev++
  }
  return { records: lines.length, types, jev, bad }
}

/** Re-tag jev/<x> records to plugin:jev-harness/<x> with ignorable:true. */
export function transformText(text) {
  const lines = text.split('\n').filter((l) => l.length > 0)
  const out = []
  let changed = 0
  for (const l of lines) {
    const o = JSON.parse(l)
    if (typeof o.type === 'string' && o.type.startsWith('jev/')) {
      o.type = 'plugin:jev-harness/' + o.type.slice('jev/'.length)
      o.ignorable = true
      changed++
    }
    out.push(JSON.stringify(o))
  }
  return { records: out, changed }
}

/**
 * Fix mislabeled turn numbers on JeV decision/receipt records.
 *
 * Older plugin versions incremented a PROCESS-LOCAL turn counter that reset to 0
 * on every restart, so decisions from later turns were written with turn=1 again.
 * The authoritative turn index lives on the host's turn/start records (data.turn).
 * Walk records in seq order, track the last turn/start's data.turn, and relabel
 * any jev/plugin jev-harness decision|receipt record whose data.turn disagrees.
 * Idempotent.
 * @param {string[]} records - JSON record strings in order.
 * @returns {{ records: string[], changed: number }}
 */
export function normalizeTurns(records) {
  const out = []
  let currentTurn = null
  let changed = 0
  for (const line of records) {
    let o
    try { o = JSON.parse(line) } catch { out.push(line); continue }
    if (o && o.type === 'turn/start' && o.data && typeof o.data.turn === 'number' && Number.isFinite(o.data.turn)) {
      currentTurn = o.data.turn
    } else if (
      o &&
      typeof o.type === 'string' &&
      /(^jev\/|^plugin:jev-harness\/)(decision|receipt)$/.test(o.type) &&
      o.data && typeof o.data === 'object' &&
      currentTurn !== null &&
      o.data.turn !== currentTurn
    ) {
      o.data.turn = currentTurn
      changed++
      out.push(JSON.stringify(o))
      continue
    }
    out.push(line)
  }
  return { records: out, changed }
}

/**
 * Recompute per-step savedTokens / ledgerChars with the current (deduped,
 * high-water) definition, so historical logs written under the old definition
 * stop showing inflated savings in the UI. Replays each decision's own
 * chunkLadder (id/chars/visibility); idempotent.
 */
export function recomputeSavings(records) {
  const hw = new Map()
  let changed = 0
  const out = []
  for (const line of records) {
    let o
    try { o = JSON.parse(line) } catch { out.push(line); continue }
    const isDecision = o && typeof o.type === 'string' && /(^jev\/|^plugin:jev-harness\/)decision$/.test(o.type)
    if (isDecision && o.data && Array.isArray(o.data.chunkLadder)) {
      let delta = 0
      let newChars = 0
      for (const e of o.data.chunkLadder) {
        if (!e || e.id === undefined || e.id === null) continue
        const chars = typeof e.chars === 'number' ? e.chars : 0
        if (chars <= 0) continue
        const lvl = e.visibility || e.level || 'full'
        const frac = lvl === 'hide' ? 0 : lvl === 'short_summary' ? 0.15 : lvl === 'long_summary' ? 0.4 : 1
        const svv = (chars * (1 - frac)) / 4
        const prev = hw.get(e.id) || { saving: 0, counted: false }
        if (svv > prev.saving) { delta += svv - prev.saving; prev.saving = svv }
        if (!prev.counted) { newChars += chars; prev.counted = true }
        hw.set(e.id, prev)
      }
      const ns = Math.round(delta)
      if (o.data.savedTokens !== ns || o.data.ledgerChars !== newChars) {
        o.data.savedTokens = ns
        o.data.ledgerChars = newChars
        changed++
        out.push(JSON.stringify(o))
        continue
      }
    }
    out.push(line)
  }
  return { records: out, changed }
}

/** Re-encode records as header frame + one record-batch frame. */
export function encodeRecords(records) {
  if (records.length === 0) throw new Error('cannot encode an empty session log')
  const header = records[0] + '\n'
  const rest = records.length > 1 ? records.slice(1).join('\n') + '\n' : ''
  const frames = [zlib.zstdCompressSync(Buffer.from(header, 'utf8'), CHECKSUM_OPTIONS)]
  if (rest) frames.push(zlib.zstdCompressSync(Buffer.from(rest, 'utf8'), CHECKSUM_OPTIONS))
  return Buffer.concat(frames)
}

/** Repair one log file. Skips clean / torn / unreadable / recently-written files. */
export function repairFile(file, options = {}) {
  const dryRun = options.dryRun === true
  const skipActiveMs = Number.isFinite(options.skipActiveMs) ? options.skipActiveMs : 0
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const report = { file, status: 'skipped', reason: '', jev: 0, records: 0, changed: 0 }
  let stat
  try { stat = statSync(file) } catch (e) { report.reason = 'stat failed: ' + e.message; return report }
  if (skipActiveMs > 0 && now - stat.mtimeMs < skipActiveMs) { report.reason = 'recently modified (possibly active)'; return report }
  let decoded
  try { decoded = decodeAllFrames(readFileSync(file)) } catch (e) { report.reason = 'decode failed: ' + e.message; return report }
  if (decoded.tornStart !== undefined) { report.reason = 'incomplete final frame at byte ' + decoded.tornStart; return report }
  const info = analyzeText(decoded.text)
  report.records = info.records
  report.jev = info.jev
  if (info.bad > 0) { report.reason = info.bad + ' unparsable record(s)'; return report }
  const t = transformText(decoded.text)   // retag bare jev/* -> plugin:jev-harness/*
  const nz = normalizeTurns(t.records)     // relabel stuck turn numbers from turn/start boundaries
  const sv = recomputeSavings(nz.records)  // recompute savedTokens/ledgerChars (deduped definition)
  report.retagged = t.changed
  report.returned = nz.changed
  report.savings = sv.changed
  report.changed = t.changed + nz.changed + sv.changed
  if (report.changed === 0) { report.status = 'clean'; return report }
  if (dryRun) { report.status = 'would-repair'; return report }
  const next = encodeRecords(sv.records)
  const nextText = decodeAllFrames(next).text
  const check = analyzeText(nextText)
  const lines = nextText.split('\n').filter((l) => l.length > 0)
  const checkTurn = normalizeTurns(lines).changed
  const checkSavings = recomputeSavings(lines).changed
  if (check.jev !== 0 || check.bad !== 0 || check.records !== info.records || checkTurn !== 0 || checkSavings !== 0) {
    report.reason = 'self-verification failed (jev=' + check.jev + ', bad=' + check.bad + ', records=' + check.records + ', turn=' + checkTurn + ', savings=' + checkSavings + ')'
    return report
  }
  const backup = file + '.bak-jevrepair-' + new Date(now).toISOString().replace(/[:.]/g, '-')
  try {
    copyFileSync(file, backup)
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, next)
    renameSync(tmp, file)
  } catch (e) {
    report.reason = 'write failed (file likely open/locked): ' + e.message
    return report
  }
  report.status = 'repaired'
  report.backup = backup
  return report
}

/** Recursively find session.v*.jsonl.zstd files under a root. */
export function findSessionLogs(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/^session\.v\d+\.jsonl\.zstd$/.test(e.name)) out.push(p)
    }
  }
  walk(root, 0)
  return out
}

/** Repair every affected log under a root. Returns per-file reports. */
export function repairAll(options = {}) {
  const root = typeof options.root === 'string' ? options.root : join(homedir(), '.dsh', 'sessions')
  const dryRun = options.dryRun === true
  const skipActiveMs = Number.isFinite(options.skipActiveMs) ? options.skipActiveMs : 0
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : Infinity
  const reports = []
  let examined = 0
  for (const file of findSessionLogs(root)) {
    if (examined >= maxFiles) break
    examined++
    let r
    try { r = repairFile(file, { dryRun, skipActiveMs }) } catch (e) { r = { file, status: 'error', reason: String(e && e.message ? e.message : e) } }
    if (r.status !== 'clean' && r.status !== 'skipped') {
      reports.push(r)
      if (typeof options.onReport === 'function') { try { options.onReport(r) } catch { /* ignore */ } }
    }
  }
  return reports
}
