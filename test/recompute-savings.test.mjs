import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recomputeSavings } from '../shared/session-log-repair.mjs'

const j=(o)=>JSON.stringify(o)

test('recomputeSavings: dedupes across steps, sets per-step delta and unique chars', () => {
  const recs = [
    j({ type:'turn/start', seq:0, time:0, data:{ turn:1 } }),
    // step 0: chunk c1 full (chars 400, full => 0 saved), c2 short (chars 800 => 680 saved)
    j({ type:'plugin:jev-harness/decision', seq:1, time:1, data:{ turn:1, step:0, savedTokens:999, ledgerChars:999, chunkLadder:[
      { id:'c1', chars:400, visibility:'full' }, { id:'c2', chars:800, visibility:'short_summary' } ] } }),
    // step 1: c1 now hidden (400*1/4=100 saved, delta +100), c2 same (no delta)
    j({ type:'plugin:jev-harness/decision', seq:2, time:2, data:{ turn:1, step:1, savedTokens:999, ledgerChars:999, chunkLadder:[
      { id:'c1', chars:400, visibility:'hide' }, { id:'c2', chars:800, visibility:'short_summary' } ] } }),
  ]
  const { records, changed } = recomputeSavings(recs)
  assert.equal(changed, 2)
  const dec = records.map((l)=>JSON.parse(l)).filter((o)=>/decision$/.test(o.type))
  assert.equal(dec[0].data.savedTokens, 170)   // c2 short: 800*(1-0.15)/4 = 170; c1 full = 0
  assert.equal(dec[0].data.ledgerChars, 1200)
  assert.equal(dec[1].data.savedTokens, 100)
  assert.equal(dec[1].data.ledgerChars, 0)
  assert.equal(recomputeSavings(records).changed, 0) // idempotent
})

test('recomputeSavings: leaves decisions without chunkLadder untouched', () => {
  const recs = [ j({ type:'plugin:jev-harness/decision', seq:0, time:0, data:{ turn:1, savedTokens:123, ledgerChars:456 } }) ]
  assert.equal(recomputeSavings(recs).changed, 0)
})
