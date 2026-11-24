import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTelemetryLogger,
  sanitizeSessionId,
  summarizeDirectory,
  summarizeJsonl,
  summarizeLegacyMarkdown,
} from '../shared/telemetry.mjs'
import { renderHtmlDashboard, runReportCli } from '../scripts/jev-report.mjs'

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-telemetry-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('shared/telemetry.mjs — async JSONL logger & summarizers', () => {
  it('writes decision and gate events asynchronously and awaits completion via flush()', async () => {
    await withTempDir(async (dir) => {
      const logger = createTelemetryLogger({ dir, writeLegacyMarkdown: true })

      logger.recordDecision('sess-alpha', {
        ts: '2026-11-24T12:00:00.000Z',
        model: 'typesafe/jev-1.14.0',
        decisionLine: 'context_visibility=short_summary; cache=reuse; routing=frontier; tools=targeted; permissions=allow; security=internal',
        parsed: {
          context_visibility: { level: 'short_summary' },
          cache_prefix: { reuse: true, action: 'reuse' },
          routing: { value: 'frontier' },
          tools: { value: 'targeted' },
          permissions: { action: 'allow' },
          security: { level: 'internal' },
        },
        latencyMs: 42,
        usage: { input_tokens: 320, output_tokens: 48 },
        chunkCount: 5,
        conditionalRulesCount: 2,
        cacheFrozen: true,
      })

      logger.recordGateEvent('sess-alpha', {
        ts: '2026-11-24T12:00:01.000Z',
        toolName: 'read',
        kind: 'deny',
        ruleId: 'deterministic-secret-path',
        reason: 'Blocked .env read',
      })

      await logger.flush('sess-alpha')

      const jsonlRaw = await readFile(join(dir, 'sess-alpha.jsonl'), 'utf8')
      const lines = jsonlRaw.trim().split(/\r?\n/).map((l) => JSON.parse(l))
      assert.equal(lines.length, 2)
      assert.equal(lines[0].type, 'decision')
      assert.equal(lines[0].sessionId, 'sess-alpha')
      assert.equal(lines[0].cacheFrozen, true)
      assert.equal(lines[0].chunkCount, 5)
      assert.equal(lines[0].conditionalRulesCount, 2)
      assert.equal(lines[1].type, 'gate')
      assert.equal(lines[1].ruleId, 'deterministic-secret-path')

      const mdRaw = await readFile(join(dir, 'sess-alpha.md'), 'utf8')
      assert.match(mdRaw, /^- 2026-11-24T12:00:00\.000Z · context_visibility=short_summary/)
    })
  })

  it('deduplicates consecutive identical decisions in memory and resets on clearSession()', async () => {
    await withTempDir(async (dir) => {
      const logger = createTelemetryLogger({ dir })
      const entry = {
        model: 'typesafe/jev-1.14.0',
        decisionLine: 'context_visibility=short_summary; cache=reuse; routing=frontier; tools=targeted; permissions=allow; security=internal',
        parsed: {
          context_visibility: { level: 'short_summary' },
          cache_prefix: { reuse: true, action: 'reuse' },
          routing: { value: 'frontier' },
          tools: { value: 'targeted' },
          permissions: { action: 'allow' },
          security: { level: 'internal' },
        },
        latencyMs: 30,
        chunkCount: 2,
        conditionalRulesCount: 1,
        cacheFrozen: true,
      }

      logger.recordDecision('sess-dedup', entry)
      logger.recordDecision('sess-dedup', { ...entry, latencyMs: 55 }) // identical signature -> skipped
      logger.recordDecision('sess-dedup', { ...entry, chunkCount: 3 }) // changed -> written
      logger.clearSession('sess-dedup')
      logger.recordDecision('sess-dedup', { ...entry, chunkCount: 3 }) // after clearSession -> written again

      await logger.flush()

      const raw = await readFile(join(dir, 'sess-dedup.jsonl'), 'utf8')
      const records = raw.trim().split(/\r?\n/).map((l) => JSON.parse(l))
      assert.equal(records.length, 3)
      assert.equal(records[0].chunkCount, 2)
      assert.equal(records[1].chunkCount, 3)
      assert.equal(records[2].chunkCount, 3)
    })
  })

  it('sanitizes malicious sessionIds to prevent path traversal outside target dir', async () => {
    await withTempDir(async (dir) => {
      const logger = createTelemetryLogger({ dir })
      const maliciousIds = [
        '../../etc/passwd',
        '..\\..\\windows\\system32',
        '.hidden/../../escape',
        'sess:with*illegal?chars<>|',
      ]

      for (const sid of maliciousIds) {
        const safe = sanitizeSessionId(sid)
        assert.equal(safe.includes('..'), false)
        assert.equal(safe.includes('/'), false)
        assert.equal(safe.includes('\\'), false)
        logger.recordDecision(sid, {
          model: 'typesafe/jev-1.14.0',
          decisionLine: 'context_visibility=hide; cache=rebuild; routing=frontier; tools=targeted; permissions=allow; security=public',
        })
      }

      await logger.flush()

      const files = await readdir(dir)
      assert.equal(files.length, maliciousIds.length)
      for (const f of files) {
        assert.ok(f.endsWith('.jsonl'))
      }
    })
  })

  it('fails open when disk path is unwritable (never throws)', async () => {
    await withTempDir(async (dir) => {
      // Create a regular file where the logger expects a directory
      const fileAsDir = join(dir, 'not-a-directory')
      await writeFile(fileAsDir, 'occupied', 'utf8')

      const logger = createTelemetryLogger({ dir: fileAsDir })
      assert.doesNotThrow(() => {
        logger.recordDecision('sess-fail-open', {
          decisionLine: 'context_visibility=full; cache=rebuild; routing=frontier; tools=full_read; permissions=allow; security=internal',
        })
        logger.recordGateEvent('sess-fail-open', {
          toolName: 'write',
          kind: 'deny',
          ruleId: 'outside-workspace-write',
        })
      })
      await assert.doesNotReject(() => logger.flush())
    })
  })

  it('summarizeJsonl computes exact metrics, skips bad lines, and calculates P95 latency', () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 500]
    const lines = [
      'not-valid-json{{{',
      '[]',
      '',
    ]

    latencies.forEach((lat, idx) => {
      const frozen = idx % 2 === 0
      const rec = {
        type: 'decision',
        ts: `2026-11-24T12:00:${String(idx).padStart(2, '0')}.000Z`,
        sessionId: 's-metrics',
        model: 'typesafe/jev-1.14.0',
        parsed: {
          context_visibility: { level: idx < 12 ? 'short_summary' : 'long_summary' },
          cache_prefix: { reuse: frozen, action: frozen ? 'reuse' : 'rebuild' },
          routing: { value: idx < 15 ? 'frontier' : 'cheap' },
          tools: { value: idx < 10 ? 'targeted' : 'search_source' },
          permissions: { action: idx === 19 ? 'deny' : 'allow' },
          security: { level: idx === 19 ? 'sensitive' : 'internal' },
        },
        latencyMs: lat,
        usage: idx % 2 === 0 ? { input_tokens: 100, output_tokens: 20 } : { prompt_tokens: 150, completion_tokens: 30 },
        cacheFrozen: frozen,
      }
      lines.push(JSON.stringify(rec))
    })

    lines.push(
      JSON.stringify({ type: 'gate', toolName: 'read', kind: 'allow', ruleId: 'allow-default' }),
      JSON.stringify({ type: 'gate', toolName: 'write', kind: 'ask', ruleId: 'outside-workspace-write' }),
      JSON.stringify({ type: 'gate', toolName: 'read', kind: 'deny', ruleId: 'deterministic-secret-path' }),
      JSON.stringify({ type: 'gate', toolName: 'run_code', kind: 'deny', ruleId: 'ptc-network-egress' })
    )

    const summary = summarizeJsonl(lines.join('\n'))
    assert.equal(summary.totalDecisions, 20)
    assert.equal(summary.totalGateEvents, 4)
    assert.equal(summary.cacheFrozenCount, 10)
    assert.equal(summary.cacheReuseRate, 0.5)
    // Mean of [10..190 (sum=1900) + 500] = 2400 / 20 = 120
    assert.equal(summary.avgLatencyMs, 120)
    // 95th percentile of 20 items: ceil(0.95 * 20) - 1 = 18 -> 190
    assert.equal(summary.p95LatencyMs, 190)
    assert.equal(summary.totalInputTokens, 10 * 100 + 10 * 150)
    assert.equal(summary.totalOutputTokens, 10 * 20 + 10 * 30)
    assert.deepEqual(summary.distributions.visibility, { short_summary: 12, long_summary: 8 })
    assert.deepEqual(summary.distributions.routing, { frontier: 15, cheap: 5 })
    assert.deepEqual(summary.distributions.tools, { targeted: 10, search_source: 10 })
    assert.deepEqual(summary.distributions.permissions, { allow: 19, deny: 1 })
    assert.deepEqual(summary.distributions.security, { internal: 19, sensitive: 1 })
    assert.deepEqual(summary.gateCounts, {
      allow: 1,
      ask: 1,
      deny: 2,
      byRuleId: {
        'allow-default': 1,
        'outside-workspace-write': 1,
        'deterministic-secret-path': 1,
        'ptc-network-egress': 1,
      },
    })
  })

  it('summarizeLegacyMarkdown parses legacy v1 markdown decision lines', () => {
    const legacyMd = [
      '# header line ignored',
      '- 2026-11-24T10:00:00.000Z · context_visibility=short_summary(0); cache=reuse(28); routing=frontier(61); tools=search_source(34); permissions=0.87; security=internal(19)',
      '- 2026-11-24T10:00:05.000Z · context_visibility=long_summary(72); cache=rebuild(40); routing=cheap(55); tools=targeted(81); permissions=0.12; security=sensitive(64)',
      'malformed bullet - skip me',
    ].join('\n')

    const summary = summarizeLegacyMarkdown(legacyMd)
    assert.equal(summary.totalDecisions, 2)
    assert.equal(summary.cacheReuseRate, 0.5)
    assert.deepEqual(summary.distributions.visibility, { short_summary: 1, long_summary: 1 })
    assert.deepEqual(summary.distributions.routing, { frontier: 1, cheap: 1 })
    assert.deepEqual(summary.distributions.tools, { search_source: 1, targeted: 1 })
    assert.deepEqual(summary.distributions.permissions, { allow: 1, ask: 1 })
    assert.deepEqual(summary.distributions.security, { internal: 1, sensitive: 1 })
  })

  it('summarizeDirectory merges JSONL and legacy MD without double-counting dual-written sessions', async () => {
    await withTempDir(async (dir) => {
      const logger = createTelemetryLogger({ dir, writeLegacyMarkdown: true })
      logger.recordDecision('dual-sess', {
        decisionLine: 'context_visibility=short_summary; cache=reuse; routing=frontier; tools=targeted; permissions=allow; security=internal',
        latencyMs: 50,
        cacheFrozen: true,
      })
      await logger.flush()

      // Add a pure legacy markdown session
      await writeFile(
        join(dir, 'legacy-only.md'),
        '- 2026-11-24T09:00:00.000Z · context_visibility=full(90); cache=rebuild(30); routing=frontier(80); tools=full_read(70); permissions=0.95; security=public(88)\n',
        'utf8'
      )

      const report = await summarizeDirectory(dir)
      assert.equal(report.sessionCount, 2)
      assert.equal(report.summary.totalDecisions, 2)
      assert.equal(report.summary.cacheFrozenCount, 1)
      const formats = report.sessions.map((s) => s.format).sort()
      assert.deepEqual(formats, ['jsonl', 'markdown'])
    })
  })
})

describe('scripts/jev-report.mjs — static HTML dashboard & XSS protection', () => {
  it('generates self-contained HTML and escapes XSS payloads in sessionId, ruleId, and paths', async () => {
    await withTempDir(async (dir) => {
      const xssPayload = '<script>alert("xss")</script><img src=x onerror=alert(1)>'
      const logger = createTelemetryLogger({ dir })

      logger.recordDecision(xssPayload, {
        decisionLine: 'context_visibility=short_summary; cache=reuse; routing=frontier; tools=targeted; permissions=allow; security=internal',
        latencyMs: 25,
        usage: { input_tokens: 120, output_tokens: 15 },
        cacheFrozen: true,
      })
      logger.recordGateEvent(xssPayload, {
        toolName: 'pwsh',
        kind: 'deny',
        ruleId: 'rule-"><script>evil()</script>',
        reason: 'XSS test',
      })
      await logger.flush()

      const outHtml = join(dir, 'report-out', 'dashboard.html')
      // Suppress stdout during CLI run assertion
      const origLog = console.log
      const captured = []
      console.log = (...args) => captured.push(args.join(' '))
      try {
        const res = await runReportCli(['--dir', dir, '--out', outHtml])
        assert.equal(res.exitCode, 0)
      } finally {
        console.log = origLog
      }

      const html = await readFile(outHtml, 'utf8')
      assert.ok(html.includes('<!DOCTYPE html>'))
      assert.ok(html.includes('prefers-color-scheme: dark'))
      assert.ok(html.includes('JEVHarness v2 Observability Dashboard'))

      // Raw unescaped XSS tags must NEVER appear in the rendered HTML
      assert.equal(html.includes('<script>alert("xss")</script>'), false)
      assert.equal(html.includes('<img src=x onerror=alert(1)>'), false)
      assert.equal(html.includes('<script>evil()</script>'), false)

      // Escaped entities MUST be present
      assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'))
      assert.ok(html.includes('rule-&quot;&gt;&lt;script&gt;evil()&lt;/script&gt;'))

      // Also test renderHtmlDashboard directly with an XSS directory string
      const directHtml = renderHtmlDashboard({
        dir: 'C:\\tmp\\<svg onload=alert(9)>',
        sessionCount: 0,
        sessions: [],
        summary: summarizeJsonl(''),
      })
      assert.equal(directHtml.includes('<svg onload=alert(9)>'), false)
      assert.ok(directHtml.includes('&lt;svg onload=alert(9)&gt;'))
    })
  })
})
