import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  authorizeGeneratedMediaObject,
  generatedMediaKeyFromRoute,
  generatedMediaRange,
  proxyGeneratedMedia,
} from '../lib/api/generated-media'

const userId = '00000000-0000-4000-8000-000000000001'
const conversationId = '10000000-0000-4000-8000-000000000001'
const generationId = '20000000-0000-4000-8000-000000000001'
const objectKey = `${userId}/${conversationId}/${generationId}/asset.png`

test('media route accepts only exact UUID-scoped content paths and single ranges', () => {
  assert.equal(generatedMediaKeyFromRoute([
    userId, conversationId, generationId, 'asset.png', 'content',
  ]), objectKey)
  assert.equal(generatedMediaKeyFromRoute([
    userId, conversationId, generationId, '../asset.png', 'content',
  ]), null)
  assert.equal(generatedMediaKeyFromRoute([userId, conversationId, generationId, 'asset.png']), null)
  assert.equal(generatedMediaRange(new Request('https://app.example/media')), null)
  assert.equal(generatedMediaRange(new Request('https://app.example/media', {
    headers: { Range: 'bytes=100-200' },
  })), 'bytes=100-200')
  assert.equal(generatedMediaRange(new Request('https://app.example/media', {
    headers: { Range: 'bytes=0-1,4-5' },
  })), false)
})

test('private proxy forwards an allow-listed range but never exposes upstream credentials', async () => {
  let upstreamRequest: { url: string; authorization: string; apikey: string; range: string } | null = null
  const response = await proxyGeneratedMedia(new Request('https://app.example/media', {
    headers: { Range: 'bytes=2-4' },
  }), userId, objectKey, {
    createAdminClient: () => ({}) as SupabaseClient,
    resolveAdminConfig: () => ({
      url: 'https://project.supabase.co',
      serviceRoleKey: 'service-role-secret',
    }),
    authorize: async () => 'allowed',
    fetcher: async (input, init) => {
      const headers = new Headers(init?.headers)
      upstreamRequest = {
        url: input.toString(),
        authorization: headers.get('authorization') ?? '',
        apikey: headers.get('apikey') ?? '',
        range: headers.get('range') ?? '',
      }
      return new Response(new Uint8Array([2, 3, 4]), {
        status: 206,
        headers: {
          'Content-Type': 'image/png',
          'Content-Range': 'bytes 2-4/10',
          'Content-Length': '3',
          'Accept-Ranges': 'bytes',
          ETag: 'opaque-etag',
          'Set-Cookie': 'upstream-secret=true',
        },
      })
    },
  })
  assert.equal(response.status, 206)
  assert.deepEqual(upstreamRequest, {
    url: `https://project.supabase.co/storage/v1/object/authenticated/generated-media/${objectKey}`,
    authorization: 'Bearer service-role-secret',
    apikey: 'service-role-secret',
    range: 'bytes=2-4',
  })
  assert.equal(response.headers.get('content-range'), 'bytes 2-4/10')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(await response.arrayBuffer().then(value => value.byteLength), 3)
  assert.equal(JSON.stringify([...response.headers]).includes('service-role-secret'), false)
})

test('proxy fails closed before storage for unauthorized, malformed, or unavailable access', async () => {
  let fetchCalls = 0
  const dependencies = {
    createAdminClient: () => ({}) as SupabaseClient,
    resolveAdminConfig: () => ({ url: 'https://project.supabase.co', serviceRoleKey: 'secret' }),
    fetcher: async () => { fetchCalls += 1; return new Response() },
  }
  const crossTenant = await proxyGeneratedMedia(
    new Request('https://app.example/media'),
    '00000000-0000-4000-8000-000000000002',
    objectKey,
    { ...dependencies, authorize: async () => 'allowed' },
  )
  assert.equal(crossTenant.status, 404)
  const nonCanonical = await proxyGeneratedMedia(
    new Request('https://app.example/media'), userId, objectKey,
    { ...dependencies, authorize: async () => 'not_found' },
  )
  assert.equal(nonCanonical.status, 404)
  const unavailable = await proxyGeneratedMedia(
    new Request('https://app.example/media'), userId, objectKey,
    { ...dependencies, authorize: async () => 'unavailable' },
  )
  assert.equal(unavailable.status, 503)
  const invalidRange = await proxyGeneratedMedia(
    new Request('https://app.example/media', { headers: { Range: 'items=1-2' } }),
    userId,
    objectKey,
    { ...dependencies, authorize: async () => 'allowed' },
  )
  assert.equal(invalidRange.status, 416)
  assert.equal(fetchCalls, 0)
})

function queryClient(results: Record<string, Array<{ data: unknown; error: unknown }>>): SupabaseClient {
  return {
    from: (table: string) => {
      const query: Record<string, unknown> = {}
      query.select = () => query
      query.eq = () => query
      query.maybeSingle = async () => results[table]?.shift() ?? { data: null, error: null }
      return query
    },
  } as unknown as SupabaseClient
}

test('authorization serves canonical receipts and exact completed legacy references only', async () => {
  assert.equal(await authorizeGeneratedMediaObject(queryClient({
    job_assets: [{ data: { state: 'canonical' }, error: null }],
  }), userId, objectKey), 'allowed')
  assert.equal(await authorizeGeneratedMediaObject(queryClient({
    job_assets: [{ data: { state: 'uploaded' }, error: null }],
  }), userId, objectKey), 'not_found')

  const legacyUrl = `https://project.supabase.co/storage/v1/object/public/generated-media/${objectKey}`
  assert.equal(await authorizeGeneratedMediaObject(queryClient({
    job_assets: [{ data: null, error: null }],
    chat_generations: [{
      data: { status: 'completed', media: [{ type: 'image', url: legacyUrl }] },
      error: null,
    }],
  }), userId, objectKey), 'allowed')
  assert.equal(await authorizeGeneratedMediaObject(queryClient({
    job_assets: [{ data: null, error: null }],
    chat_generations: [{
      data: { status: 'running', media: [{ type: 'image', url: legacyUrl }] },
      error: null,
    }],
  }), userId, objectKey), 'not_found')
})
