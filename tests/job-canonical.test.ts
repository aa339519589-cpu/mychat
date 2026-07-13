import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalJobJson, sha256JobBytes, sha256JobValue } from '../lib/jobs/canonical'

test('job input fingerprints are stable across object key order', () => {
  const left = { z: [true, null, 4], a: { second: '二', first: '一' } }
  const right = { a: { first: '一', second: '二' }, z: [true, null, 4] }
  assert.equal(canonicalJobJson(left), canonicalJobJson(right))
  assert.equal(sha256JobValue(left), sha256JobValue(right))
  assert.match(sha256JobValue(left), /^[0-9a-f]{64}$/)
  assert.equal(sha256JobBytes('mychat'), 'f0f96b177c150e3c44a8c13e379eac5b6a9a2d408f13c97c35be285ba74988f3')
})

test('canonical job JSON rejects values outside the durable JSON contract', () => {
  assert.throws(() => canonicalJobJson(Number.NaN), /non-finite/)
  assert.throws(() => canonicalJobJson(new Date() as never), /non-plain/)
  let nested: unknown = null
  for (let index = 0; index < 34; index += 1) nested = [nested]
  assert.throws(() => canonicalJobJson(nested as never), /too deep/)
})
