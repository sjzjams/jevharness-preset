#!/usr/bin/env node
/**
 * CLI: repair legacy JeV session logs (bare jev/* events) so they open again.
 *
 *   node scripts/repair-jev-session-logs.mjs                 # repair all under ~/.dsh/sessions
 *   node scripts/repair-jev-session-logs.mjs --dry-run       # report only
 *   node scripts/repair-jev-session-logs.mjs --root <dir>    # custom sessions root
 *   node scripts/repair-jev-session-logs.mjs --skip-active 15000   # skip files written in the last N ms
 */
import { repairAll } from '../shared/session-log-repair.mjs'

const args = process.argv.slice(2)
const opts = { dryRun: false, root: undefined, skipActiveMs: 0 }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--dry-run') opts.dryRun = true
  else if (a === '--root') opts.root = args[++i]
  else if (a === '--skip-active') opts.skipActiveMs = Number(args[++i]) || 0
}

const reports = repairAll({
  root: opts.root,
  dryRun: opts.dryRun,
  skipActiveMs: opts.skipActiveMs,
  onReport: (r) => console.log((opts.dryRun ? '[dry] ' : '') + r.status + '  ' + r.file + (r.changed ? '  (jev=' + r.jev + ' -> ' + r.changed + ' retagged)' : '') + (r.reason ? '  [' + r.reason + ']' : '')),
})
if (reports.length === 0) console.log('No legacy jev/* session logs found — nothing to repair.')
else {
  const repaired = reports.filter((r) => r.status === 'repaired').length
  const would = reports.filter((r) => r.status === 'would-repair').length
  console.log('\nDone. repaired=' + repaired + ' would-repair=' + would + ' total-affected=' + reports.length)
}
