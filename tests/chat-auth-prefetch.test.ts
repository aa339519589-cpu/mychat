import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveAuth } from '../lib/api/guard'
import { prefetchChatEndpoints } from '../lib/chat/admission-prefetch'

test('configuration can load during authentication, but full user verification still gates admission', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch
  const previousUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const previousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-test-key'
  let releaseAuth!: () => void
  const authGate = new Promise<void>(resolve => { releaseAuth = resolve })
  let configurationStarted!: () => void
  const configurationGate = new Promise<void>(resolve => { configurationStarted = resolve })
  let authRequested = false
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.includes('/auth/v1/user')) {
      authRequested = true
      await authGate
      return Response.json({ id: 'verified-user', email: 'user@example.test', is_anonymous: false })
    }
    if (url.includes('/rest/v1/endpoints')) {
      configurationStarted()
      return Response.json([])
    }
    throw new Error('Unexpected diagnostic request')
  }
  try {
    let prefetch: ReturnType<typeof prefetchChatEndpoints> | undefined
    let verified = false
    const authentication = resolveAuth(new Request('https://mychat.example/api/chat', {
      headers: { Authorization: 'Bearer test-token' },
    }), client => { prefetch = prefetchChatEndpoints(client) }).then(auth => { verified = true; return auth })
    await configurationGate
    assert.equal(authRequested, true)
    assert.deepEqual(await prefetch, [])
    assert.equal(verified, false, 'A completed configuration read must not replace authentication')
    releaseAuth()
    assert.equal((await authentication).userId, 'verified-user')
  } finally {
    releaseAuth()
    globalThis.fetch = originalFetch
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previousUrl
    if (previousKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = previousKey
  }
})

test('failed configuration prefetch permits the existing authoritative lookup to run', async () => {
  const client = { from: () => { throw new Error('Temporary configuration read failure') } }
  assert.equal(await prefetchChatEndpoints(client as never), null)
})
