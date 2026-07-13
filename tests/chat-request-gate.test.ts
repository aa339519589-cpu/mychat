import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { AuthCtx } from '../lib/api/guard'
import {
  enforceQuotaLimit,
  enforceRequestRateLimit,
} from '../lib/api/guard'
import type { RateLimitResult } from '../lib/rate-limit'

test('chat performs maintenance, auth and distributed rate limiting before reading the large body', () => {
  const route = readFileSync(new URL('../app/api/chat/route.ts', import.meta.url), 'utf8')
  const maintenance = route.indexOf('generationMaintenanceResponse()')
  const auth = route.indexOf('await resolveAuth()')
  const rate = route.indexOf('await enforceRequestRateLimit(auth, req)')
  const body = route.indexOf('await readJson(req, { maxBytes: 48 * 1024 * 1024 })')
  const quota = route.indexOf('await enforceQuotaLimit(auth, { quota: endpointId === undefined })')

  assert.ok(maintenance >= 0)
  assert.ok(maintenance < auth)
  assert.ok(auth < rate)
  assert.ok(rate < body)
  assert.ok(body < quota)
  assert.equal(route.match(/await resolveAuth\(\)/g)?.length, 1)
  assert.equal(route.match(/await enforceRequestRateLimit\(auth, req\)/g)?.length, 1)
  assert.equal(route.includes('enforceLimits(auth, req'), false)
})

test('staged rate and quota gates consume each dependency exactly once', async () => {
  const auth = {
    supabase: {} as AuthCtx['supabase'],
    userId: '00000000-0000-4000-8000-000000000001',
    isAnonymous: false,
  }
  let rateCalls = 0
  let quotaCalls = 0
  const rateLimit = async (key: string, options: { max?: number; windowMs?: number } = {}) => {
    rateCalls += 1
    assert.equal(key, `user:${auth.userId}`)
    assert.deepEqual(options, { max: 30, windowMs: 60_000 })
    return {
      allowed: true,
      remaining: 29,
      retryAfterSeconds: 0,
      backend: 'database',
    } satisfies RateLimitResult
  }

  const rate = await enforceRequestRateLimit(auth, new Request('https://example.test/api/chat'), {
    rateLimit,
  })
  assert.equal(rate.response, undefined)

  const quota = await enforceQuotaLimit(auth, { quota: true }, {
    quotaCheck: async (_supabase, userId) => {
      quotaCalls += 1
      assert.equal(userId, auth.userId)
      return { exceeded: false, usingBalance: true }
    },
  })
  assert.equal(quota.response, undefined)
  assert.equal(quota.usingBalance, true)
  assert.equal(rateCalls, 1)
  assert.equal(quotaCalls, 1)
})

test('authentication dependency failure stops before consuming rate capacity', async () => {
  let rateCalls = 0
  const gate = await enforceRequestRateLimit({
    supabase: null,
    userId: null,
    isAnonymous: true,
    authUnavailable: true,
  }, new Request('https://example.test/api/chat'), {
    rateLimit: async () => {
      rateCalls += 1
      return {
        allowed: true,
        remaining: 9,
        retryAfterSeconds: 0,
        backend: 'database',
      }
    },
  })

  assert.equal(gate.response?.status, 503)
  assert.equal(rateCalls, 0)
})
