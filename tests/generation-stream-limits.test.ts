import assert from 'node:assert/strict'
import test from 'node:test'
import { acquireGenerationStreamPermit } from '../lib/generation/stream-limits'

test('per-user stream concurrency is capped and every release path is idempotent', () => {
  const userId = `stream-limit-${crypto.randomUUID()}`
  const first = acquireGenerationStreamPermit(userId, 2)
  const second = acquireGenerationStreamPermit(userId, 2)
  const rejected = acquireGenerationStreamPermit(userId, 2)

  assert.equal(first.acquired, true)
  assert.equal(second.acquired, true)
  assert.equal(rejected.acquired, false)
  if (!first.acquired || !second.acquired) return

  first.release()
  first.release()
  const replacement = acquireGenerationStreamPermit(userId, 2)
  assert.equal(replacement.acquired, true)

  second.release()
  if (replacement.acquired) replacement.release()
  const clean = acquireGenerationStreamPermit(userId, 2)
  assert.equal(clean.acquired, true)
  if (clean.acquired) clean.release()
})
