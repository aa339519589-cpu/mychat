import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  acquireJobEventStreamLease,
  jobEventStreamAddressHash,
  streamAdmissionHashKey,
} from '../lib/jobs/stream-admission'

const streamId = '94000000-0000-4000-8000-000000000001'
const hardExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
const addressKey = 'stream-admission-test-key-material-00000001'

function rpcClient(handler: (name: string, args: Record<string, unknown>) => unknown) {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => ({
      data: handler(name, args),
      error: null,
    }),
  } as unknown as SupabaseClient
}

test('stream admission stores a scoped address digest and owns renewal/release', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = rpcClient((name, args) => {
    calls.push({ name, args })
    if (name === 'acquire_job_event_stream') return {
      acquired: true,
      streamId,
      hardExpiresAt,
      leaseExpiresAt: new Date(Date.now() + 45_000).toISOString(),
    }
    if (name === 'renew_job_event_stream') return { renewed: true }
    if (name === 'release_job_event_stream') return { released: true }
    return null
  })
  const admission = await acquireJobEventStreamLease({
    principalId: '94000000-0000-4000-8000-000000000002',
    jobId: '94000000-0000-4000-8000-000000000003',
    address: '203.0.113.7',
  }, {
    createAdminClient: () => client,
    randomUUID: () => streamId,
    addressHashKey: addressKey,
  })
  assert.equal(admission.acquired, true)
  if (!admission.acquired) return
  assert.equal(admission.lease.maxDurationMs, 15 * 60_000)
  assert.equal(await admission.lease.renew(), true)
  await admission.lease.release()
  await admission.lease.release()
  assert.deepEqual(calls.map(call => call.name), [
    'acquire_job_event_stream', 'renew_job_event_stream', 'release_job_event_stream',
  ])
  const addressHash = calls[0]?.args.input_address_hash
  assert.equal(addressHash, jobEventStreamAddressHash('203.0.113.7', addressKey))
  assert.match(String(addressHash), /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(calls).includes('203.0.113.7'), false)
})

test('stream admission fails closed and preserves distributed retry guidance', async () => {
  const capacityClient = rpcClient(() => ({
    acquired: false,
    reason: 'capacity',
    retryAfterSeconds: 9,
  }))
  assert.deepEqual(await acquireJobEventStreamLease({
    principalId: '94000000-0000-4000-8000-000000000002',
    jobId: '94000000-0000-4000-8000-000000000003',
    address: '198.51.100.9',
  }, {
    createAdminClient: () => capacityClient,
    randomUUID: () => streamId,
    addressHashKey: addressKey,
  }), {
    acquired: false,
    kind: 'capacity',
    retryAfterSeconds: 9,
  })
  assert.deepEqual(await acquireJobEventStreamLease({
    principalId: '94000000-0000-4000-8000-000000000002',
    jobId: '94000000-0000-4000-8000-000000000003',
    address: '198.51.100.9',
  }, { createAdminClient: () => null, addressHashKey: addressKey }), {
    acquired: false,
    kind: 'unavailable',
    retryAfterSeconds: 5,
  })
})

test('stream address hashes are key-separated and production fails closed without key material', async () => {
  assert.notEqual(
    jobEventStreamAddressHash('203.0.113.7', addressKey),
    jobEventStreamAddressHash('203.0.113.7', 'stream-admission-test-key-material-00000002'),
  )
  const client = rpcClient(() => {
    throw new Error('RPC must not run without hash authority')
  })
  assert.deepEqual(await acquireJobEventStreamLease({
    principalId: '94000000-0000-4000-8000-000000000002',
    jobId: '94000000-0000-4000-8000-000000000003',
    address: '203.0.113.7',
  }, { createAdminClient: () => client, addressHashKey: null }), {
    acquired: false,
    kind: 'unavailable',
    retryAfterSeconds: 5,
  })
})

test('production requires a dedicated stream hash key and never reuses service-role authority', () => {
  const serviceRoleKey = 'supabase-service-role-key-material-00000001'
  const serviceRoleEnvironment = {
    NODE_ENV: 'production',
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  }
  assert.equal(streamAdmissionHashKey(serviceRoleEnvironment), null)
  assert.equal(streamAdmissionHashKey({
    ...serviceRoleEnvironment,
    STREAM_ADMISSION_HASH_KEY: 'too-short',
  }), null)
  assert.equal(streamAdmissionHashKey({
    ...serviceRoleEnvironment,
    STREAM_ADMISSION_HASH_KEY: addressKey,
  }), addressKey)
})

test('only development has a deterministic stream hash fallback', () => {
  assert.equal(
    streamAdmissionHashKey({ NODE_ENV: 'development' }),
    'mychat-development-stream-admission-key',
  )
  assert.equal(streamAdmissionHashKey({
    NODE_ENV: 'development',
    STREAM_ADMISSION_HASH_KEY: 'explicit-but-too-short',
  }), null)
  assert.equal(streamAdmissionHashKey({ NODE_ENV: 'test' }), null)
  const multibyteKey = '密'.repeat(11)
  assert.equal(streamAdmissionHashKey({
    NODE_ENV: 'production',
    STREAM_ADMISSION_HASH_KEY: multibyteKey,
  }), multibyteKey)
  assert.match(jobEventStreamAddressHash('203.0.113.7', multibyteKey), /^[0-9a-f]{64}$/)
})
