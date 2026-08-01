import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { AuthCtx } from '../lib/api/guard'
import {
  enforceQuotaLimit,
  enforceRequestRateLimit,
} from '../lib/api/guard'
import type { RateLimitResult } from '../lib/rate-limit'

test('chat authenticates and applies distributed rate limiting before reading the large body', () => {
  const route = readFileSync(new URL('../app/api/chat/route.ts', import.meta.url), 'utf8')
  const auth = route.indexOf('await resolveAuth(request)')
  const rate = route.indexOf('await enforceRequestRateLimit(auth, request)')
  const body = route.indexOf('await readJson(request, { maxBytes: 8 * 1024 * 1024 })')
  const policy = route.indexOf('await resolveAdmissionPolicy(request, auth, body)')
  const selection = route.indexOf('selection = await resolveChatModelSelection')
  const quota = route.indexOf("await enforceQuotaLimit(auth, { quota: true })")

  assert.ok(auth >= 0)
  assert.ok(auth < rate)
  assert.ok(rate < body)
  assert.ok(body < policy)
  assert.ok(selection >= 0)
  assert.ok(selection < quota)
  assert.equal(route.match(/await resolveAuth\(request\)/g)?.length, 1)
  assert.equal(route.match(/await enforceRequestRateLimit\(auth, request\)/g)?.length, 1)
  assert.equal(route.match(/await resolveAdmissionPolicy\(request, auth, body\)/g)?.length, 1)
  assert.equal(route.match(/enforceQuotaLimit\(auth, \{ quota: true \}\)/g)?.length, 1)
  assert.match(route, /selection\.accessClass === 'quota'/)
  assert.match(route, /allowPremium: true/)
  assert.match(route, /selection\.accessClass !== 'quota' && auth\.isOwner !== true/)
  assert.equal(route.includes('allowPremium: auth.isOwner === true'), false)
  assert.equal(route.includes("selection.accessClass === 'trial'"), false)
  assert.equal(route.includes('enforceLimits(auth, request'), false)
})

test('staged rate and quota gates consume each dependency exactly once', async () => {
  const auth = {
    supabase: {} as AuthCtx['supabase'],
    userId: '00000000-0000-4000-8000-000000000001',
    email: 'user@example.test',
    isOwner: false,
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

test('owner account bypasses platform request and quota gates', async () => {
  const auth: AuthCtx = {
    supabase: {} as AuthCtx['supabase'],
    userId: '00000000-0000-4000-8000-000000000002',
    email: 'owner@example.test',
    isOwner: true,
    isAnonymous: false,
  }
  let rateCalls = 0
  let quotaCalls = 0

  const rate = await enforceRequestRateLimit(auth, new Request('https://example.test/api/chat'), {
    rateLimit: async () => {
      rateCalls += 1
      throw new Error('owner rate dependency should not run')
    },
  })
  const quota = await enforceQuotaLimit(auth, { quota: true }, {
    quotaCheck: async () => {
      quotaCalls += 1
      throw new Error('owner quota dependency should not run')
    },
  })

  assert.equal(rate.response, undefined)
  assert.equal(quota.response, undefined)
  assert.equal(quota.usingBalance, false)
  assert.equal(rateCalls, 0)
  assert.equal(quotaCalls, 0)
})

test('authentication dependency failure stops before consuming rate capacity', async () => {
  let rateCalls = 0
  const gate = await enforceRequestRateLimit({
    supabase: null,
    userId: null,
    email: null,
    isOwner: false,
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
