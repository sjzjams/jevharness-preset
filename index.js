/**
 * JEVHarness preset — host half of the client bundle.
 *
 * The bundle patch (cordis.patch.yml) declares the agent preset and loads the
 * per-step loop (./jev-harness-loop/index.mjs), which owns the live RPC channel.
 * The browser UI lives in ./client.js. This root module's only job is to prove
 * the self-insert plugin row actually instantiated the package: it records the
 * web client module graph to a JSON marker on load.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function apply(ctx) {
  try {
    const dir = join(homedir(), '.dsh', 'jev-decisions')
    mkdirSync(dir, { recursive: true })
    const info = { hostHalfLoaded: true }
    try {
      const cm = ctx && typeof ctx.get === 'function' ? ctx.get('clientModules') : null
      const g = cm && typeof cm.graph === 'function' ? cm.graph() : null
      const gs = g ? JSON.stringify(g) : ''
      info.clientModulesAvailable = !!cm
      info.graphAvailable = !!g
      info.entryCount = g && Array.isArray(g.entries) ? g.entries.length : null
      info.containsPreset = /@local\/dsh-jevharness-preset/.test(gs)
      info.containsAnyJev = /jev/i.test(gs)
    } catch (e) {
      info.graphError = String((e && e.message) || e)
    }
    writeFileSync(join(dir, '_ui-root.json'), JSON.stringify({ ts: new Date().toISOString(), ...info }, null, 2), 'utf8')
  } catch {
    /* diagnostics are fail-open */
  }
}
