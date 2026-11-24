import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  gatewayBase,
  gatewayKey,
  clearGatewayKeyCache,
  callSystemOne,
} from '../shared/gateway.mjs'

describe('shared/gateway.mjs — Magpie System One client', () => {
  let dir
  let envFile

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'jev-gw-test-'))
    envFile = join(dir, '.env')
  })

  after(() => {
    clearGatewayKeyCache()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('gatewayBase respects override and default', () => {
    assert.equal(gatewayBase('http://127.0.0.1:9999/v1/'), 'http://127.0.0.1:9999/v1')
  })

  it('gatewayKey reads custom env file and invalidates cache when mtime/size changes', () => {
    clearGatewayKeyCache()
    writeFileSync(envFile, 'OTHER=1\nMAGPIE_GATEWAY_KEY="secret-k1"\n', 'utf8')
    assert.equal(gatewayKey(envFile), 'secret-k1')
    // Cached hit
    assert.equal(gatewayKey(envFile), 'secret-k1')

    // Update content & advance mtime
    writeFileSync(envFile, 'MAGPIE_GATEWAY_KEY=secret-k2-updated\n', 'utf8')
    const future = new Date(Date.now() + 5000)
    utimesSync(envFile, future, future)
    assert.equal(gatewayKey(envFile), 'secret-k2-updated')
  })

  it('callSystemOne returns normalized success shape with latencyMs and requestId', async () => {
    const fakeFetch = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:3425/v1/systemone')
      assert.equal(init.headers.authorization, 'Bearer test-key-123')
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-typesafe-request-id': 'req-42' }),
        text: async () => JSON.stringify({
          model: 'typesafe/jev-1.14.0',
          answers: { cache_prefix: { type: 'noul', noul: 0.8 } },
          usage: { input_tokens: 100 },
        }),
      }
    }

    const res = await callSystemOne({
      state: { goal: 'test' },
      questions: { cache_prefix: { type: 'noul' } },
      apiKey: 'test-key-123',
      baseUrl: 'http://127.0.0.1:3425/v1',
      fetchImpl: fakeFetch,
    })

    assert.equal(res.ok, true)
    assert.equal(res.model, 'typesafe/jev-1.14.0')
    assert.equal(res.requestId, 'req-42')
    assert.equal(typeof res.latencyMs, 'number')
    assert.deepEqual(res.usage, { input_tokens: 100 })
  })

  it('callSystemOne handles HTTP errors, invalid JSON, timeout, and never leaks apiKey', async () => {
    const secretKey = 'super-secret-token-xyz'

    const errRes = await callSystemOne({
      state: 's',
      questions: { q: { type: 'noul' } },
      apiKey: secretKey,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: async () => JSON.stringify({ error: { message: `bad key ${secretKey}` } }),
      }),
    })
    assert.equal(errRes.ok, false)
    assert.equal(errRes.status, 401)
    assert.equal(errRes.error.includes(secretKey), false)
    assert.match(errRes.error, /\[REDACTED\]/)

    const badJsonRes = await callSystemOne({
      state: 's',
      questions: { q: { type: 'noul' } },
      apiKey: secretKey,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => 'not-json',
      }),
    })
    assert.equal(badJsonRes.ok, false)
    assert.match(badJsonRes.error, /invalid JSON/i)

    const timeoutRes = await callSystemOne({
      state: 's',
      questions: { q: { type: 'noul' } },
      apiKey: secretKey,
      timeoutMs: 25,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason || new DOMException('aborted', 'AbortError')))
      }),
    })
    assert.equal(timeoutRes.ok, false)
    assert.match(timeoutRes.error, /timed out/i)
  })
})
