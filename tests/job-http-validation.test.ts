import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { isUuid, validate } from '../lib/validation'

const valid = '83000000-0000-4000-8000-000000000004'

test('durable job HTTP routes accept canonical UUIDs and reject truncated identities', () => {
  assert.equal(isUuid(valid), true)
  assert.equal(validate.uuid(valid, 'jobId'), valid)
  assert.equal(isUuid('83000000-0000-4000-000000000004'), false)
  assert.equal(isUuid(`${valid}-extra`), false)
  assert.equal(isUuid('../jobs'), false)
})

test('all durable job routes share the canonical UUID validator', async () => {
  const sources = await Promise.all([
    '../app/api/v1/jobs/[jobId]/route.ts',
    '../app/api/v1/jobs/[jobId]/cancel/route.ts',
    '../app/api/v1/jobs/[jobId]/events/route.ts',
    '../app/api/v1/conversations/[conversationId]/generation/route.ts',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))
  for (const source of sources) {
    assert.match(source, /import \{ isUuid \} from '@\/lib\/validation'/)
    assert.match(source, /!isUuid\(/)
    assert.doesNotMatch(source, /const UUID\s*=/)
  }
})
