import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStepQuestions,
  parseAnswer,
  parseScoreWithRisk,
  parseNoul,
  parseDecision,
  bucketConfidence,
  SECURITY_LEVELS,
  MAX_PER_CHUNK_QUESTIONS,
} from '../shared/answers.mjs'

describe('shared/answers.mjs — Table I schema & parsers', () => {
  it('buildStepQuestions generates exact Table I question types', () => {
    const q = buildStepQuestions()
    assert.deepEqual(Object.keys(q), [
      'context_visibility',
      'cache_prefix',
      'routing',
      'tools',
      'permissions',
      'security',
    ])

    assert.equal(q.context_visibility.type, 'choice')
    assert.deepEqual(Object.keys(q.context_visibility.criteria), [
      'hide',
      'short_summary',
      'long_summary',
      'full',
    ])

    assert.equal(q.cache_prefix.type, 'noul')

    assert.equal(q.routing.type, 'choice')
    assert.deepEqual(Object.keys(q.routing.criteria), ['frontier', 'cheap', 'background'])

    assert.equal(q.tools.type, 'choice')
    assert.deepEqual(Object.keys(q.tools.criteria), [
      'targeted',
      'full_read',
      'search_source',
      'execute_verify',
    ])

    assert.equal(q.permissions.type, 'choice')
    assert.deepEqual(Object.keys(q.permissions.criteria), ['allow', 'ask', 'deny'])

    assert.equal(q.security.type, 'score')
    assert.equal(Array.isArray(q.security.criteria), true)
    assert.equal(q.security.criteria.length, 4)
  })

  it('buildStepQuestions appends per-chunk choice questions capped at 12 and deduplicated', () => {
    const ids = Array.from({ length: 16 }, (_, i) => `c${i + 1}`)
    ids.splice(2, 0, 'c1', '', '   ')
    const q = buildStepQuestions(ids)
    const chunkKeys = Object.keys(q).filter((k) => k.startsWith('chunk_vis_'))
    assert.equal(chunkKeys.length, MAX_PER_CHUNK_QUESTIONS)
    assert.equal(chunkKeys[0], 'chunk_vis_c1')
    assert.equal(chunkKeys[11], 'chunk_vis_c12')
    assert.equal(q.chunk_vis_c1.type, 'choice')
    assert.deepEqual(Object.keys(q.chunk_vis_c1.criteria), [
      'hide',
      'short_summary',
      'long_summary',
      'full',
    ])
  })

  it('parseScoreWithRisk escalates bimodal security distribution when tail prob >= 0.35', () => {
    // 55% public (0), 5% internal (1), 10% sensitive (2), 30% secret (3)
    // Expected score = 0*0.55 + 1*0.05 + 2*0.10 + 3*0.30 = 1.15 -> rounds to "internal" (1),
    // but P(sensitive) + P(secret) = 0.40 >= 0.35 -> must escalate to "sensitive" (2)!
    const raw = {
      type: 'score',
      score: 1.15,
      confidence: 0.22,
      probabilities: [0.55, 0.05, 0.10, 0.30],
    }
    const parsed = parseScoreWithRisk(raw, SECURITY_LEVELS)
    assert.equal(parsed.rawLevel, 'internal')
    assert.equal(parsed.level, 'sensitive')
    assert.equal(parsed.index, 2)
    assert.equal(parsed.escalated, true)
    assert.equal(parsed.highRiskTailProb, 0.4)
    assert.equal(parsed.lowConfidence, true)
    assert.equal(parsed.bucket, 'low')
  })

  it('parseScoreWithRisk does not escalate when tail probability is below 0.35', () => {
    const raw = {
      type: 'score',
      score: 0.9,
      confidence: 0.78,
      probabilities: [0.25, 0.60, 0.10, 0.05],
    }
    const parsed = parseScoreWithRisk(raw, SECURITY_LEVELS)
    assert.equal(parsed.level, 'internal')
    assert.equal(parsed.index, 1)
    assert.equal(parsed.escalated, false)
    assert.equal(parsed.highRiskTailProb, 0.15)
    assert.equal(parsed.lowConfidence, false)
    assert.equal(parsed.bucket, 'high')
  })

  it('parseDecision falls back context_visibility to short_summary when confidence < 0.2', () => {
    const dec = parseDecision({
      model: 'typesafe/jev-1.14.0',
      answers: {
        context_visibility: { type: 'choice', choice: 'full', confidence: 0.12 },
        chunk_vis_c1: { type: 'choice', choice: 'hide', confidence: 0.15 },
        chunk_vis_c2: { type: 'choice', choice: 'full', confidence: 0.82 },
        cache_prefix: { type: 'noul', noul: 0.76 },
        routing: { type: 'choice', choice: 'frontier', confidence: 0.65 },
        tools: { type: 'choice', choice: 'execute_verify', confidence: 0.8 },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.91 },
        security: { type: 'score', score: 0.8, confidence: 0.6, probabilities: [0.3, 0.6, 0.08, 0.02] },
      },
    })

    assert.equal(dec.context_visibility.level, 'short_summary')
    assert.equal(dec.context_visibility.rawLevel, 'full')
    assert.equal(dec.context_visibility.fallback, true)

    assert.equal(dec.chunk_visibility.c1.level, 'short_summary')
    assert.equal(dec.chunk_visibility.c1.fallback, true)
    assert.equal(dec.chunk_visibility.c2.level, 'full')
    assert.equal(dec.chunk_visibility.c2.fallback, false)

    assert.equal(dec.cache_prefix.reuse, true)
    assert.equal(dec.cache_prefix.action, 'reuse')
    assert.equal(dec.routing.value, 'frontier')
    assert.equal(dec.tools.value, 'execute_verify')
    assert.equal(dec.permissions.action, 'allow')
    assert.equal(dec.security.level, 'internal')
  })

  it('parseDecision remains backward compatible with legacy v1 answer shapes', () => {
    const legacy = {
      model: 'typesafe/jev-1.14.0',
      answers: {
        context_visibility: { type: 'score', score: 2.1, confidence: 0.55 },
        cache_prefix: { type: 'choice', choice: 'rebuild', confidence: 0.7 },
        routing: { type: 'choice', choice: 'cheap', confidence: 0.62 },
        tools: { type: 'choice', choice: 'targeted', confidence: 0.8 },
        permissions: { type: 'noul', noul: 0.14 },
        security: { type: 'score', score: 2.8, confidence: 0.88 },
      },
    }
    const dec = parseDecision(legacy)
    assert.equal(dec.context_visibility.level, 'long_summary')
    assert.equal(dec.context_visibility.sourceKind, 'score')
    assert.equal(dec.cache_prefix.reuse, false)
    assert.equal(dec.cache_prefix.action, 'rebuild')
    assert.equal(dec.cache_prefix.sourceKind, 'choice')
    assert.equal(dec.permissions.legacyNoul, true)
    assert.equal(dec.permissions.action, 'ask')
    assert.equal(dec.permissions.probability, 0.14)
    assert.equal(dec.security.level, 'secret')
    assert.equal(dec.security.index, 3)
  })

  it('parseNoul and parseAnswer handle threshold and raw primitives', () => {
    const n1 = parseNoul({ type: 'noul', noul: 0.62 }, 0.5)
    assert.equal(n1.value, true)
    assert.equal(n1.probability, 0.62)

    const n2 = parseNoul({ type: 'noul', noul: 0.62 }, 0.7)
    assert.equal(n2.value, false)

    const pBool = parseAnswer(true)
    assert.equal(pBool.kind, 'noul')
    assert.equal(pBool.boolValue, true)
  })

  it('bucketConfidence maps continuous values to low / med / high', () => {
    assert.equal(bucketConfidence(null), 'low')
    assert.equal(bucketConfidence(0), 'low')
    assert.equal(bucketConfidence(0.44), 'low')
    assert.equal(bucketConfidence(0.45), 'med')
    assert.equal(bucketConfidence(0.74), 'med')
    assert.equal(bucketConfidence(0.75), 'high')
    assert.equal(bucketConfidence(1.0), 'high')
  })
})
