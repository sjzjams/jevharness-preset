import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTurns } from '../shared/session-log-repair.mjs'

const j = (o) => JSON.stringify(o)

test('normalizeTurns: relabels decisions to the surrounding turn/start data.turn', () => {
  const records = [
    j({ type: 'session', version: 4, id: 's' }),
    j({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    j({ type: 'plugin:jev-harness/decision', seq: 1, time: 2, data: { turn: 1, step: 0 } }),
    j({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1 } }),
    j({ type: 'turn/start', seq: 3, time: 4, data: { turn: 2 } }),
    // mislabeled by a restarted process-local counter:
    j({ type: 'plugin:jev-harness/decision', seq: 4, time: 5, data: { turn: 1, step: 0 } }),
    j({ type: 'jev/decision', seq: 5, time: 6, data: { turn: 1, step: 1 } }),
    j({ type: 'turn/start', seq: 6, time: 7, data: { turn: 3 } }),
    j({ type: 'plugin:jev-harness/decision', seq: 7, time: 8, data: { turn: 1, step: 0 } }),
  ]
  const { records: out, changed } = normalizeTurns(records)
  assert.equal(changed, 3)
  const turns = out.map((l) => JSON.parse(l)).filter((o) => /decision$/.test(o.type)).map((o) => o.data.turn)
  assert.deepEqual(turns, [1, 2, 2, 3])
  // idempotent
  assert.equal(normalizeTurns(out).changed, 0)
})

test('normalizeTurns: leaves non-decision events and already-correct turns untouched', () => {
  const records = [
    j({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
    j({ type: 'plugin:jev-harness/gate', seq: 1, time: 2, data: { turn: 9 } }),
    j({ type: 'plugin:jev-harness/decision', seq: 2, time: 3, data: { turn: 1 } }),
  ]
  assert.equal(normalizeTurns(records).changed, 0)
})
