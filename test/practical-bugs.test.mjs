import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChunkStore } from '../shared/chunk-store.mjs'
import { evaluateToolGate, classifyRunCodeAccess } from '../shared/policy.mjs'
import { parseDecision } from '../shared/answers.mjs'
import { createSubgoalTracker } from '../shared/subgoal-tracker.mjs'
import { apply, resolveSessionId } from '../jev-harness-loop/index.mjs'

function createMockCtx() {
  const listeners = new Map()
  const registeredTools = new Map()
  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    tools: { register(def) { registeredTools.set(def.name, def) } },
  }

  async function runAssemble(base, context) {
    const handlers = listeners.get('system-prompt/assemble') || []
    let idx = 0
    const next = async () => (idx >= handlers.length ? base : handlers[idx++]({}, context, next))
    return next()
  }

  async function runPreExecute(exec) {
    const handlers = listeners.get('tools/pre-execute') || []
    let idx = 0
    const next = async () => (idx >= handlers.length ? { kind: 'allow' } : handlers[idx++](exec, next))
    return next()
  }

  // Invoke the post-execute chain with a next() that throws, simulating the
  // actual tool body erroring after pre-execute registered a subgoal.
  async function runPostExecuteWithError(exec) {
    const handlers = listeners.get('tools/post-execute') || []
    const throwingNext = async () => { throw new Error('tool blew up') }
    for (const fn of handlers) {
      try {
        await fn(exec, undefined, throwingNext)
      } catch {
        // the host observes the tool error; the loop must already have released state
      }
    }
  }

  function emitSessionEvent(session, event) {
    for (const fn of listeners.get('session/event') || []) fn(session, event)
  }

  return { ctx, registeredTools, emitSessionEvent, runAssemble, runPreExecute, runPostExecuteWithError }
}

function jevBase(cwd) {
  return {
    sections: [{ name: 'persona', text: 'running as a JeV harness\n# JeV engineering contract' }],
    contexts: [{ name: 'session-env', text: 'Current working directory: "' + cwd + '".\nCurrent DSH file policy: danger-full-access.\nApproval prompts are disabled in this session.' }],
  }
}

function decisionFetch() {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'req-1' },
    async text() {
      return JSON.stringify({
        model: 'jev-test',
        answers: {
          context_visibility: { type: 'choice', choice: 'short_summary', confidence: 0.8 },
          cache_prefix: { type: 'noul', noul: 0.8, confidence: 0.8 },
          routing: { type: 'choice', choice: 'frontier', confidence: 0.9 },
          tools: { type: 'choice', choice: 'targeted', confidence: 0.8 },
          permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
          security: { type: 'score', score: 1, confidence: 0.85 },
        },
      })
    },
  })
}

describe('practical bug regressions', () => {
  it('bug 4: chunk-store digest Tip advertises the real jev_chunk_read parameter name (chunk_id)', () => {
    const store = createChunkStore()
    store.addChunk('tip', { kind: 'file_read', source: 'src/a.mjs', fullText: 'export const a = 1' })
    const digest = store.renderDigest('tip')
    assert.match(digest, /jev_chunk_read\(\{ chunk_id,/)
    assert.doesNotMatch(digest, /jev_chunk_read\(\{ id,/)
  })

  it('bug 1: PTC run_code outside-write check ignores read paths/data and only flags actual write targets', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'jev-ptc-write-'))
    try {
      const readOutsideWriteInside = 'const fs = await import("node:fs");' +
        'const h = fs.readFileSync("/etc/hosts","utf8");' +
        'fs.writeFileSync("out.txt", h);'
      const readRes = evaluateToolGate({ toolName: 'run_code', args: { code: readOutsideWriteInside }, cwd, approvalDisabled: true })
      assert.equal(readRes.kind, 'allow', 'reading /etc/hosts then writing inside must not be flagged')

      const dataMentionsPath = 'const fs = await import("node:fs");' +
        'fs.writeFileSync("out.json", JSON.stringify({ note: "saved to /tmp/scratch" }));'
      const dataRes = evaluateToolGate({ toolName: 'run_code', args: { code: dataMentionsPath }, cwd, approvalDisabled: true })
      assert.equal(dataRes.kind, 'allow', 'a path-looking string inside write data must not be flagged')

      const outsideTarget = join(cwd, '..', 'escaped-outside.txt')
      const lit = JSON.stringify(outsideTarget)
      const outsideCode = 'const fs = await import("node:fs"); fs.writeFileSync(' + lit + ', "x");'
      const outsideRes = evaluateToolGate({ toolName: 'run_code', args: { code: outsideCode }, cwd, approvalDisabled: true })
      assert.equal(outsideRes.kind, 'deny')
      assert.equal(outsideRes.ruleId, 'ptc-outside-workspace-write')

      const toolsWrite = 'await tools.write({ file_path: ' + lit + ', content: "x" });'
      const twRes = evaluateToolGate({ toolName: 'run_code', args: { code: toolsWrite }, cwd, approvalDisabled: true })
      assert.equal(twRes.kind, 'deny')
      assert.equal(twRes.ruleId, 'ptc-outside-workspace-write')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('bug 3: PTC run_code is graded read/write by its body for permission gating', () => {
    const cwd = process.cwd()
    const denyDecision = parseDecision({
      answers: {
        security: { type: 'score', score: 1, confidence: 0.8 },
        permissions: { type: 'choice', choice: 'deny', confidence: 0.9 },
      },
    })

    assert.equal(classifyRunCodeAccess('const fs = await import("node:fs"); return fs.readFileSync("a.js","utf8")'), 'read')
    assert.equal(classifyRunCodeAccess('const fs = await import("node:fs"); fs.writeFileSync("a.js","x")'), 'write')
    assert.equal(classifyRunCodeAccess('await tools.edit({ file_path: "a.js" })'), 'write')
    assert.equal(classifyRunCodeAccess('const cp = await import("node:child_process"); cp.spawnSync("node", ["am.mjs"])'), 'write')
    assert.equal(classifyRunCodeAccess('await tools.pwsh({ command: "node am.mjs render x" })'), 'write')

    const readOnly = evaluateToolGate({
      toolName: 'run_code',
      args: { code: 'const fs = await import("node:fs"); return fs.readFileSync("a.js","utf8")' },
      cwd,
      decision: denyDecision,
      approvalDisabled: true,
    })
    assert.equal(readOnly.kind, 'allow', 'read-only run_code must not be blocked by permissions=deny')

    const write = evaluateToolGate({
      toolName: 'run_code',
      args: { code: 'const fs = await import("node:fs"); fs.writeFileSync("a.js","x")' },
      cwd,
      decision: denyDecision,
      approvalDisabled: true,
    })
    assert.equal(write.kind, 'deny')
    assert.equal(write.ruleId, 'jev-permissions-deny')
  })

  it('bug 2a: stale in-flight subgoals expire so a lost completion cannot self-lock the tracker', () => {
    let clock = 1000000
    const tracker = createSubgoalTracker({ inFlightTtlMs: 10000, now: () => clock })
    const reg = tracker.registerSubgoal('s', {
      id: 'sg-1',
      description: 'Refactor auth middleware',
      prompt: 'Edit src/auth.mjs',
      access: 'write',
      paths: ['src/auth.mjs'],
    })
    assert.equal(reg.registered, true)

    assert.equal(tracker.checkDuplicate('s', { description: 'Refactor auth middleware', prompt: 'Edit src/auth.mjs', paths: ['src/auth.mjs'] }).duplicate, true)

    clock += 5000
    assert.equal(tracker.checkDuplicate('s', { description: 'Refactor auth middleware', prompt: 'Edit src/auth.mjs', paths: ['src/auth.mjs'] }).duplicate, true)

    clock += 20000
    const dup = tracker.checkDuplicate('s', { description: 'Refactor auth middleware', prompt: 'Edit src/auth.mjs', paths: ['src/auth.mjs'] })
    assert.equal(dup.duplicate, false)
    const reReg = tracker.registerSubgoal('s', {
      id: 'sg-2',
      description: 'Refactor auth middleware again',
      prompt: 'Edit src/auth.mjs',
      access: 'write',
      paths: ['src/auth.mjs'],
    })
    assert.equal(reReg.registered, true)
  })

  it('bug 2b: a tool error after subgoal registration releases the lock (no duplicate self-lock on retry)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'jev-selflock-'))
    try {
      const harness = createMockCtx()
      apply(harness.ctx, {
        apiKey: 'test-key',
        fetchImpl: decisionFetch(),
        telemetryDir: join(tmpDir, '.tel'),
        throttleMs: 0,
      })

      await harness.runAssemble(jevBase(tmpDir), { toolSet: {}, agent: { session: { id: 'sess-lock' } } })
      assert.equal(resolveSessionId({ agent: { session: { id: 'sess-lock' } } }, 'exec'), 'sess-lock')

      const subagentArgs = {
        name: 'writer-1',
        description: 'Refactor router error handling',
        prompt: 'Modify src/router.mjs to emit structured errors',
      }
      const first = await harness.runPreExecute({ id: 'call-1', name: 'subagent', args: subagentArgs, agent: { session: { id: 'sess-lock' } } })
      assert.equal(first.kind, 'allow')

      await harness.runPostExecuteWithError({ id: 'call-1', name: 'subagent', args: subagentArgs, agent: { session: { id: 'sess-lock' } } })

      const retry = await harness.runPreExecute({ id: 'call-2', name: 'subagent', args: { ...subagentArgs, name: 'writer-2' }, agent: { session: { id: 'sess-lock' } } })
      assert.equal(retry.kind, 'allow', 'retry after a tool error must not be blocked as a duplicate/lock conflict')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('bug 1b: dynamic path args are conservatively resolved; commented/quoted calls are not parsed', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'jev-ptc-dyn-'))
    try {
      const insideJoin = 'const fs = await import("node:fs"); const path = await import("node:path");' +
        'fs.writeFileSync(path.join(process.cwd(), "out.txt"), "x");'
      assert.equal(evaluateToolGate({ toolName: 'run_code', args: { code: insideJoin }, cwd, approvalDisabled: true }).kind, 'allow')

      const outsideJoin = 'const fs = await import("node:fs"); const path = await import("node:path");' +
        'fs.writeFileSync(path.join("/tmp", "evil.txt"), "x");'
      const insideDel = evaluateToolGate({ toolName: 'run_code', args: { code: outsideJoin }, cwd, approvalDisabled: true })
      assert.equal(insideDel.kind, 'deny')
      assert.equal(insideDel.ruleId, 'ptc-outside-workspace-write')

      const templateExternal = 'const fs = await import("node:fs"); const n = "a";' +
        'fs.writeFileSync(`/tmp/${n}.txt`, "x");'
      assert.equal(evaluateToolGate({ toolName: 'run_code', args: { code: templateExternal }, cwd, approvalDisabled: true }).kind, 'deny')

      const commentMention = '// tools.edit({ file_path: "/tmp/x" })\n' +
        'const fs = await import("node:fs"); fs.writeFileSync("out.txt", "y");'
      assert.equal(evaluateToolGate({ toolName: 'run_code', args: { code: commentMention }, cwd, approvalDisabled: true }).kind, 'allow')

      const stringMention = 'const s = "tools.write({ file_path: \'/tmp/x\' })";' +
        'const fs = await import("node:fs"); fs.writeFileSync("out.txt", "y"); return s;'
      assert.equal(evaluateToolGate({ toolName: 'run_code', args: { code: stringMention }, cwd, approvalDisabled: true }).kind, 'allow')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('bug 2c: gate-denial tool results are not re-ingested as chunks (no feedback into JeV)', async () => {
    const harness = createMockCtx()
    apply(harness.ctx, { apiKey: 'test-key', telemetryEnabled: false, throttleMs: 0 })

    harness.emitSessionEvent({ id: 'sess-feed' }, {
      type: 'tool/result',
      data: { name: 'read', source: 'src/a.mjs', message: { content: [{ type: 'text', text: 'export const a = 1' }] } },
    })
    harness.emitSessionEvent({ id: 'sess-feed' }, {
      type: 'tool/result',
      data: {
        name: 'read',
        source: '.env',
        isError: true,
        message: { content: [{ type: 'text', text: 'Error: JEVHarness blocked access to a secret path (.env/.ssh/keys/credentials/passwd/.pem/wxid).' }] },
      },
    })
    harness.emitSessionEvent({ id: 'sess-feed' }, {
      type: 'tool/result',
      data: {
        name: 'write',
        source: 'src/a.mjs',
        isError: true,
        message: { content: [{ type: 'text', text: 'Error: JeV permissions=deny (confidence 0.82) for tool "write"; blocked by JEVHarness.' }] },
      },
    })

    const packTool = harness.registeredTools.get('jev_retrieval_pack')
    const pack = await packTool.execute({ max_sensitivity: 'sensitive', max_chars: 4000 }, { agent: { session: { id: 'sess-feed' } } })
    assert.equal(pack.totalChunks, 1, 'only the benign read should be stored')
    assert.ok(!pack.rendered.includes('JEVHarness blocked'))
    assert.ok(!pack.rendered.includes('JeV permissions='))
  })

  it('residual C1: a bare ".." segment in path.join is treated as an outside-write', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'jev-ptc-dotdot-'))
    try {
      const code = 'const fs = await import("node:fs"); const path = await import("node:path");' +
        "fs.writeFileSync(path.join('..','evil.txt'), 'x');"
      const res = evaluateToolGate({ toolName: 'run_code', args: { code }, cwd, approvalDisabled: true })
      assert.equal(res.kind, 'deny')
      assert.equal(res.ruleId, 'ptc-outside-workspace-write')

      const inside = 'const fs = await import("node:fs"); const path = await import("node:path");' +
        "fs.writeFileSync(path.join(process.cwd(),'out.txt'), 'x');"
      assert.equal(evaluateToolGate({ toolName: 'run_code', args: { code: inside }, cwd, approvalDisabled: true }).kind, 'allow')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('residual C2: a sensitive filename inside a documentation string is not a secret-access hit', () => {
    const env = '.' + 'env'
    const doc = 'const report = "# Security: never store secrets in ' + env + ' files.";' +
      'await tools.write({ file_path: "report.md", content: report });'
    assert.equal(evaluateToolGate({ toolName: 'run_code', args: { code: doc }, cwd: process.cwd(), approvalDisabled: true }).kind, 'allow')

    const realRead = 'const fs = await import("node:fs"); return fs.readFileSync(' + JSON.stringify(env) + ', "utf8");'
    const blocked = evaluateToolGate({ toolName: 'run_code', args: { code: realRead }, cwd: process.cwd(), approvalDisabled: true })
    assert.equal(blocked.kind, 'deny')
    assert.equal(blocked.ruleId, 'ptc-secret-access')
  })

  it('residual C3: commented/quoted write-call names do not upgrade a read-only script', () => {
    assert.equal(classifyRunCodeAccess('// fs.writeFileSync("x")\nconst s = "writeFileSync";\nreturn 1'), 'read')
    assert.equal(classifyRunCodeAccess('const fs = await import("node:fs"); fs.writeFileSync("a.js","x")'), 'write')
  })

  it('residual C4: tools.write dynamic path ignores sibling content strings', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'jev-ptc-objpath-'))
    try {
      const dynContent = 'const p = "out.txt"; await tools.write({ file_path: p, content: "saved /tmp/a" });'
      assert.equal(evaluateToolGate({ toolName: 'run_code', args: { code: dynContent }, cwd, approvalDisabled: true }).kind, 'allow')

      const dynEscape = 'await tools.write({ file_path: path.join("..","x.txt"), content: "hi" });'
      const esc = evaluateToolGate({ toolName: 'run_code', args: { code: dynEscape }, cwd, approvalDisabled: true })
      assert.equal(esc.kind, 'deny')
      assert.equal(esc.ruleId, 'ptc-outside-workspace-write')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
