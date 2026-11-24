#!/usr/bin/env node
/**
 * JEVHarness / scripts/jev-report.mjs
 *
 * Standalone local observability report CLI replacing jev-decision-ui.
 * Pure Node 20+ ESM, zero external dependencies.
 *
 * Usage:
 *   node scripts/jev-report.mjs [--dir <path>] [--out <htmlPath>] [--json]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_TELEMETRY_DIR, summarizeDirectory } from '../shared/telemetry.mjs'

export function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    dir: DEFAULT_TELEMETRY_DIR,
    out: null,
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dir' && i + 1 < argv.length) {
      opts.dir = argv[++i]
    } else if (arg.startsWith('--dir=')) {
      opts.dir = arg.slice('--dir='.length)
    } else if (arg === '--out' && i + 1 < argv.length) {
      opts.out = argv[++i]
    } else if (arg.startsWith('--out=')) {
      opts.out = arg.slice('--out='.length)
    } else if (arg === '--json') {
      opts.json = true
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    }
  }

  return opts
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;')
}

function pct(ratio) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '0.0%'
  return `${(ratio * 100).toFixed(1)}%`
}

function formatNumber(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  return n.toLocaleString('en-US')
}

function formatDistInline(dist) {
  const entries = Object.entries(dist || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  if (entries.length === 0) return '(none)'
  return entries.map(([k, v]) => `${k}=${v}`).join(', ')
}

export function formatTerminalReport(report) {
  const s = report.summary
  const frozenRate = s.totalDecisions > 0 ? s.cacheFrozenCount / s.totalDecisions : 0
  const cacheReuseCount = Math.round(s.cacheReuseRate * s.totalDecisions)
  const cacheRebuildCount = Math.max(0, s.totalDecisions - cacheReuseCount)
  const totalTokens = s.totalInputTokens + s.totalOutputTokens

  const lines = [
    '============================================================',
    '  JEVHarness v2 Observability Report',
    '============================================================',
    `Directory         : ${report.dir}`,
    `Sessions          : ${report.sessionCount}`,
    `Total Decisions   : ${formatNumber(s.totalDecisions)}`,
    `Total Gate Events : ${formatNumber(s.totalGateEvents)}`,
    `Latency (avg/p95) : ${s.avgLatencyMs.toFixed(2)} ms / ${s.p95LatencyMs.toFixed(2)} ms`,
    `JeV Tokens        : ${formatNumber(totalTokens)} (in: ${formatNumber(s.totalInputTokens)}, out: ${formatNumber(s.totalOutputTokens)})`,
    `Cache Frozen Rate : ${pct(frozenRate)} (${s.cacheFrozenCount}/${s.totalDecisions}) | Reuse Rate: ${pct(s.cacheReuseRate)}`,
    '',
    'Six-Decision Distributions:',
    `  1. context_visibility : ${formatDistInline(s.distributions.visibility)}`,
    `  2. cache_prefix       : reuse=${cacheReuseCount}, rebuild=${cacheRebuildCount} (frozen=${s.cacheFrozenCount})`,
    `  3. routing            : ${formatDistInline(s.distributions.routing)}`,
    `  4. tools              : ${formatDistInline(s.distributions.tools)}`,
    `  5. permissions        : ${formatDistInline(s.distributions.permissions)}`,
    `  6. security           : ${formatDistInline(s.distributions.security)}`,
    '',
    'Permission Gate Summary:',
    `  allow=${s.gateCounts.allow}, ask=${s.gateCounts.ask}, deny=${s.gateCounts.deny}`,
    `  byRuleId: ${formatDistInline(s.gateCounts.byRuleId)}`,
  ]

  if (report.sessions.length > 0) {
    lines.push('', 'Per-Session Breakdown (top 15):')
    const top = [...report.sessions]
      .sort((a, b) => b.totalDecisions - a.totalDecisions || b.totalGateEvents - a.totalGateEvents)
      .slice(0, 15)
    for (const sess of top) {
      const fRate = sess.totalDecisions > 0 ? pct(sess.cacheFrozenCount / sess.totalDecisions) : '0.0%'
      lines.push(
        `  - ${sess.sessionId} [${sess.format}] steps=${sess.totalDecisions} gates=${sess.totalGateEvents} (deny=${sess.gateCounts.deny}) frozen=${fRate} p95=${sess.p95LatencyMs.toFixed(1)}ms`
      )
    }
  }

  lines.push('============================================================')
  return lines.join('\n')
}

function renderDistributionCard(title, dist, total) {
  const entries = Object.entries(dist || {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  const denom = Math.max(1, total || entries.reduce((sum, [, v]) => sum + v, 0))

  const rows =
    entries.length === 0
      ? '<p class="empty">No data recorded</p>'
      : entries
          .map(([label, count]) => {
            const width = Math.min(100, Math.max(2, Math.round((count / denom) * 100)))
            const share = ((count / denom) * 100).toFixed(1)
            return `
            <div class="bar-row">
              <div class="bar-meta">
                <span class="bar-label">${escapeHtml(label)}</span>
                <span class="bar-val">${formatNumber(count)} (${share}%)</span>
              </div>
              <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
            </div>`
          })
          .join('')

  return `
    <section class="card">
      <h3>${escapeHtml(title)}</h3>
      <div class="bar-list">${rows}</div>
    </section>`
}

export function renderHtmlDashboard(report, generatedAt = new Date().toISOString()) {
  const s = report.summary
  const frozenRate = s.totalDecisions > 0 ? s.cacheFrozenCount / s.totalDecisions : 0
  const cacheReuseCount = Math.round(s.cacheReuseRate * s.totalDecisions)
  const cacheRebuildCount = Math.max(0, s.totalDecisions - cacheReuseCount)
  const totalTokens = s.totalInputTokens + s.totalOutputTokens

  const cacheDist = {
    reuse: cacheReuseCount,
    rebuild: cacheRebuildCount,
    frozen: s.cacheFrozenCount,
  }

  const ruleRows = Object.entries(s.gateCounts.byRuleId || {})
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(
      ([ruleId, count]) => `
      <tr>
        <td><code>${escapeHtml(ruleId)}</code></td>
        <td class="num">${formatNumber(count)}</td>
      </tr>`
    )
    .join('')

  const sessionRows = report.sessions
    .map((sess) => {
      const sessFrozenRate = sess.totalDecisions > 0 ? sess.cacheFrozenCount / sess.totalDecisions : 0
      return `
      <tr>
        <td><code>${escapeHtml(sess.sessionId)}</code></td>
        <td><span class="badge">${escapeHtml(sess.format)}</span></td>
        <td class="num">${formatNumber(sess.totalDecisions)}</td>
        <td class="num">${pct(sessFrozenRate)}</td>
        <td class="num">${pct(sess.cacheReuseRate)}</td>
        <td class="num">${sess.avgLatencyMs.toFixed(1)} / ${sess.p95LatencyMs.toFixed(1)} ms</td>
        <td class="num">${formatNumber(sess.totalInputTokens + sess.totalOutputTokens)}</td>
        <td class="num">${sess.gateCounts.allow} / ${sess.gateCounts.ask} / <strong class="deny-text">${sess.gateCounts.deny}</strong></td>
      </tr>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>JEVHarness v2 Telemetry Dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9;
      --surface: #ffffff;
      --border: #d9dfe7;
      --text: #161b22;
      --muted: #586474;
      --accent: #2563eb;
      --accent-soft: #dbeafe;
      --ok: #15803d;
      --warn: #b45309;
      --deny: #b91c1c;
      --code-bg: #eef2f7;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0d1117;
        --surface: #161b22;
        --border: #30363d;
        --text: #e6edf3;
        --muted: #8b949e;
        --accent: #58a6ff;
        --accent-soft: #1f3350;
        --ok: #3fb950;
        --warn: #d29922;
        --deny: #f85149;
        --code-bg: #21262d;
      }
    }
    [data-theme="light"] {
      --bg: #f6f7f9;
      --surface: #ffffff;
      --border: #d9dfe7;
      --text: #161b22;
      --muted: #586474;
      --accent: #2563eb;
      --accent-soft: #dbeafe;
      --ok: #15803d;
      --warn: #b45309;
      --deny: #b91c1c;
      --code-bg: #eef2f7;
    }
    [data-theme="dark"] {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --accent-soft: #1f3350;
      --ok: #3fb950;
      --warn: #d29922;
      --deny: #f85149;
      --code-bg: #21262d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 20px 48px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    h1 { margin: 0 0 6px; font-size: 1.5rem; }
    h2 { margin: 28px 0 12px; font-size: 1.15rem; }
    h3 { margin: 0 0 12px; font-size: 0.95rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .meta { font-size: 0.85rem; color: var(--muted); }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.85em;
    }
    .theme-btn {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .kpi-label { font-size: 0.8rem; color: var(--muted); margin-bottom: 4px; }
    .kpi-value { font-size: 1.45rem; font-weight: 700; }
    .kpi-sub { font-size: 0.78rem; color: var(--muted); margin-top: 2px; }
    .grid-3 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
    }
    .bar-row { margin-bottom: 10px; }
    .bar-meta { display: flex; justify-content: space-between; font-size: 0.84rem; margin-bottom: 4px; gap: 8px; }
    .bar-label { font-weight: 600; word-break: break-all; }
    .bar-val { color: var(--muted); white-space: nowrap; }
    .bar-track { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; background: var(--accent); }
    .gate-pills { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .pill { padding: 4px 10px; border-radius: 999px; font-size: 0.84rem; font-weight: 600; border: 1px solid var(--border); }
    .pill-allow { color: var(--ok); }
    .pill-ask { color: var(--warn); }
    .pill-deny { color: var(--deny); }
    .deny-text { color: var(--deny); }
    .badge {
      display: inline-block;
      font-size: 0.75rem;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 600;
    }
    .table-wrap {
      overflow-x: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; }
    th { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr:last-child td { border-bottom: none; }
    .empty { color: var(--muted); font-size: 0.85rem; margin: 4px 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>JEVHarness v2 Observability Dashboard</h1>
        <div class="meta">
          Source: <code>${escapeHtml(report.dir)}</code> &middot; Generated: ${escapeHtml(generatedAt)}
        </div>
      </div>
      <button type="button" class="theme-btn" id="themeToggle">Toggle Theme</button>
    </header>

    <section class="kpi-grid">
      <div class="kpi">
        <div class="kpi-label">Sessions</div>
        <div class="kpi-value">${formatNumber(report.sessionCount)}</div>
        <div class="kpi-sub">JSONL + Legacy MD</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total Decisions</div>
        <div class="kpi-value">${formatNumber(s.totalDecisions)}</div>
        <div class="kpi-sub">Gate events: ${formatNumber(s.totalGateEvents)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Latency (Avg / P95)</div>
        <div class="kpi-value">${s.avgLatencyMs.toFixed(1)} ms</div>
        <div class="kpi-sub">P95: ${s.p95LatencyMs.toFixed(1)} ms</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Cache Frozen Rate</div>
        <div class="kpi-value">${pct(frozenRate)}</div>
        <div class="kpi-sub">Reuse rate: ${pct(s.cacheReuseRate)}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">JeV Tokens</div>
        <div class="kpi-value">${formatNumber(totalTokens)}</div>
        <div class="kpi-sub">In: ${formatNumber(s.totalInputTokens)} &middot; Out: ${formatNumber(s.totalOutputTokens)}</div>
      </div>
    </section>

    <h2>Six-Decision Distributions</h2>
    <div class="grid-3">
      ${renderDistributionCard('1. Context Visibility', s.distributions.visibility, s.totalDecisions)}
      ${renderDistributionCard('2. Cache Prefix', cacheDist, s.totalDecisions)}
      ${renderDistributionCard('3. Routing', s.distributions.routing, s.totalDecisions)}
      ${renderDistributionCard('4. Tool Strategy', s.distributions.tools, s.totalDecisions)}
      ${renderDistributionCard('5. Permissions', s.distributions.permissions, s.totalDecisions)}
      ${renderDistributionCard('6. Security Level', s.distributions.security, s.totalDecisions)}
    </div>

    <h2>Permission Gate Interceptions</h2>
    <section class="card">
      <div class="gate-pills">
        <span class="pill pill-allow">allow: ${formatNumber(s.gateCounts.allow)}</span>
        <span class="pill pill-ask">ask: ${formatNumber(s.gateCounts.ask)}</span>
        <span class="pill pill-deny">deny: ${formatNumber(s.gateCounts.deny)}</span>
      </div>
      ${
        ruleRows
          ? `<div class="table-wrap"><table><thead><tr><th>Rule ID</th><th class="num">Count</th></tr></thead><tbody>${ruleRows}</tbody></table></div>`
          : '<p class="empty">No gate events recorded.</p>'
      }
    </section>

    <h2>Session Breakdown</h2>
    <div class="table-wrap">
      ${
        sessionRows
          ? `<table>
              <thead>
                <tr>
                  <th>Session ID</th>
                  <th>Format</th>
                  <th class="num">Decisions</th>
                  <th class="num">Frozen</th>
                  <th class="num">Reuse</th>
                  <th class="num">Avg / P95</th>
                  <th class="num">Tokens</th>
                  <th class="num">Allow / Ask / Deny</th>
                </tr>
              </thead>
              <tbody>${sessionRows}</tbody>
            </table>`
          : '<p class="empty" style="padding:16px">No telemetry sessions found in directory.</p>'
      }
    </div>
  </div>
  <script>
    (function () {
      var btn = document.getElementById('themeToggle');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var root = document.documentElement;
        var current = root.getAttribute('data-theme');
        if (current === 'dark') root.setAttribute('data-theme', 'light');
        else if (current === 'light') root.setAttribute('data-theme', 'dark');
        else {
          var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          root.setAttribute('data-theme', prefersDark ? 'light' : 'dark');
        }
      });
    })();
  </script>
</body>
</html>
`
}

export async function runReportCli(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv)
  if (opts.help) {
    console.log('Usage: node scripts/jev-report.mjs [--dir <path>] [--out <htmlPath>] [--json]')
    return { exitCode: 0, report: null }
  }

  const report = await summarizeDirectory(opts.dir)

  if (opts.out) {
    const outPath = resolve(opts.out)
    await mkdir(dirname(outPath), { recursive: true })
    const html = renderHtmlDashboard(report)
    await writeFile(outPath, html, 'utf8')
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatTerminalReport(report))
    if (opts.out) {
      console.log(`HTML dashboard written to: ${resolve(opts.out)}`)
    }
  }

  return { exitCode: 0, report }
}

const isEntrypoint =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (isEntrypoint) {
  runReportCli().catch((err) => {
    console.error(`jev-report failed: ${err?.message || String(err)}`)
    process.exitCode = 1
  })
}
