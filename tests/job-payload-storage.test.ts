import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  JobPayloadStorageError,
  loadJobPayload,
  persistJobPayload,
  removeJobPayload,
} from '../lib/jobs/payload-storage'

function memoryStorage() {
  const objects = new Map<string, Uint8Array>()
  const bucket = {
    async upload(key: string, value: Uint8Array) {
      if (objects.has(key)) return { error: { statusCode: 409, message: 'Duplicate' } }
      objects.set(key, value)
      return { error: null }
    },
    async download(key: string) {
      const value = objects.get(key)
      return value ? { data: new Blob([value]), error: null } : { data: null, error: { message: 'missing' } }
    },
    async remove(keys: string[]) {
      keys.forEach(key => objects.delete(key))
      return { error: null }
    },
  }
  const client = { storage: { from: () => bucket } } as unknown as SupabaseClient
  return { objects, dependencies: { createAdminClient: () => client } }
}

test('private job payload storage is idempotent and verifies scope and digest', async () => {
  const storage = memoryStorage()
  const scope = { userId: 'user_1', jobId: 'job_1' }
  const payload = { tier: '绝句', nested: { b: 2, a: 1 } }
  const first = await persistJobPayload({ ...scope, payload }, storage.dependencies)
  const replay = await persistJobPayload({ ...scope, payload }, storage.dependencies)
  assert.deepEqual(replay, first)
  assert.deepEqual(await loadJobPayload(first, scope, storage.dependencies), {
    nested: { a: 1, b: 2 }, tier: '绝句',
  })
  await assert.rejects(loadJobPayload(first, { ...scope, jobId: 'other' }, storage.dependencies), error => (
    error instanceof JobPayloadStorageError && error.code === 'invalid_payload'
  ))
  storage.objects.set(first.objectKey, new TextEncoder().encode('{"tampered":true}'))
  await assert.rejects(loadJobPayload(first, scope, storage.dependencies), error => (
    error instanceof JobPayloadStorageError && error.code === 'integrity_failed'
  ))
  await removeJobPayload(first, scope, storage.dependencies)
  assert.equal(storage.objects.size, 0)
})

test('job payload storage fails closed without service credentials', async () => {
  await assert.rejects(
    persistJobPayload({ userId: 'user', jobId: 'job', payload: {} }, { createAdminClient: () => null }),
    error => error instanceof JobPayloadStorageError && error.code === 'admin_unavailable',
  )
})
