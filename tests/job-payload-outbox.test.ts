import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { JobOutboxMessage } from '../lib/jobs/outbox-contracts'
import { SupabaseJobOutboxRepository } from '../lib/jobs/supabase-outbox'

const principalId = '97000000-0000-4000-8000-000000000001'
const jobId = '97000000-0000-4000-8000-000000000002'
const objectKey = `${principalId}/${jobId}/${'a'.repeat(64)}.json`

function message(): JobOutboxMessage {
  return {
    id: '97000000-0000-4000-8000-000000000003',
    jobId,
    principalId,
    topic: 'payloads.cleanup',
    payload: { jobId },
    attempt: 1,
    maxAttempts: 10,
    lockVersion: 7,
    lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  }
}

test('payload cleanup validates scope and tombstones only after Storage succeeds', async () => {
  const rpcCalls: string[] = []
  const removed: string[][] = []
  const client = {
    rpc: async (name: string) => {
      rpcCalls.push(name)
      return { data: name === 'prepare_job_payload_cleanup'
        ? { prepared: true, objectKey }
        : { finished: true }, error: null }
    },
    storage: {
      from: (bucket: string) => {
        assert.equal(bucket, 'job-payloads')
        return {
          remove: async (keys: string[]) => {
            removed.push(keys)
            return { error: null }
          },
        }
      },
    },
  } as unknown as SupabaseClient
  const repository = new SupabaseJobOutboxRepository({ createAdminClient: () => client })
  assert.equal(await repository.cleanupPayload({ message: message(), workerId: 'payload-worker' }), true)
  assert.deepEqual(removed, [[objectKey]])
  assert.deepEqual(rpcCalls, ['prepare_job_payload_cleanup', 'finish_job_payload_cleanup'])
})

test('payload cleanup rejects a database plan outside the principal and Job scope', async () => {
  let storageCalled = false
  const client = {
    rpc: async () => ({ data: {
      prepared: true,
      objectKey: `other/${jobId}/${'b'.repeat(64)}.json`,
    }, error: null }),
    storage: {
      from: () => {
        storageCalled = true
        return { remove: async () => ({ error: null }) }
      },
    },
  } as unknown as SupabaseClient
  const repository = new SupabaseJobOutboxRepository({ createAdminClient: () => client })
  await assert.rejects(
    repository.cleanupPayload({ message: message(), workerId: 'payload-worker' }),
    /malformed/,
  )
  assert.equal(storageCalled, false)
})
