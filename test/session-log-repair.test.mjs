import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { repairFile, decodeAllFrames, analyzeText, scanZstdFrames } from '../shared/session-log-repair.mjs'

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

function buildLegacyLog(id) {
  const header = JSON.stringify({ type: 'session', version: 4, id, createdAt: 1 }) + '\n'
  const rows = [
    JSON.stringify({ type: 'session/end-seed', seq: 0, time: 1, data: {} }),
    JSON.stringify({ type: 'jev/decision', seq: 1, time: 2, data: { turn: 0, step: 1 } }),
    JSON.stringify({ type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } }),
    JSON.stringify({ type: 'jev/gate', seq: 3, time: 4, data: { verdict: 'deny' } }),
  ]
  const f0 = zlib.zstdCompressSync(Buffer.from(header, 'utf8'), CHECKSUM)
  const f1 = zlib.zstdCompressSync(Buffer.from(rows.slice(0, 2).join('\n') + '\n', 'utf8'), CHECKSUM)
  const f2 = zlib.zstdCompressSync(Buffer.from(rows.slice(2).join('\n') + '\n', 'utf8'), CHECKSUM)
  return Buffer.concat([f0, f1, f2])
}

test('repair: retags bare jev/* events to ignorable plugin records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevrepair-'))
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, buildLegacyLog('session-x'))
    const before = analyzeText(decodeAllFrames(readFileSync(file)).text)
    assert.equal(before.jev, 2, 'legacy log starts with 2 bare jev events')
    const r = repairFile(file, { skipActiveMs: 0 })
    assert.equal(r.status, 'repaired')
    assert.equal(r.changed, 2)
    const after = analyzeText(decodeAllFrames(readFileSync(file)).text)
    assert.equal(after.jev, 0)
    assert.equal(after.records, before.records, 'record count is preserved')
    const recs = decodeAllFrames(readFileSync(file)).text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const dec = recs.find((x) => x.type === 'plugin:jev-harness/decision')
    const gate = recs.find((x) => x.type === 'plugin:jev-harness/gate')
    assert.ok(dec && dec.ignorable === true && dec.seq === 1)
    assert.ok(gate && gate.ignorable === true && gate.seq === 3)
    assert.ok(readdirSync(dir).some((n) => n.includes('.bak-jevrepair-')), 'creates a backup')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('repair: leaves a clean log untouched and does not rewrite it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jevrepair-clean-'))
  try {
    const file = join(dir, 'session.v4.jsonl.zstd')
    const header = JSON.stringify({ type: 'session', version: 4, id: 'c', createdAt: 1 }) + '\n'
    const row = JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: {} }) + '\n'
    writeFileSync(file, Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(header, 'utf8'), CHECKSUM),
      zlib.zstdCompressSync(Buffer.from(row, 'utf8'), CHECKSUM),
    ]))
    const r = repairFile(file, { skipActiveMs: 0 })
    assert.equal(r.status, 'clean')
    assert.ok(!readdirSync(dir).some((n) => n.includes('.bak-jevrepair-')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('repair: scanner reports torn final frame without repairing', () => {
  const buf = buildLegacyLog('t')
  const { tornStart } = scanZstdFrames(buf.subarray(0, buf.length - 5))
  assert.equal(typeof tornStart, 'number')
})
