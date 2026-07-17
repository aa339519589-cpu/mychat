import assert from 'node:assert/strict'
import test from 'node:test'
import { toJson } from '../lib/supabase/json'

test('JSON normalization creates detached JSON and preserves dangerous keys as data', () => {
  const source = Object.freeze({
    enabled: true,
    nested: Object.freeze([1, Object.freeze({ value: 'ok', omitted: undefined })]),
  })
  const dangerous = Object.create(null) as Record<string, unknown>
  dangerous.__proto__ = { controlled: true }

  assert.deepEqual(toJson(source), {
    enabled: true,
    nested: [1, { value: 'ok' }],
  })
  const normalized = toJson(dangerous) as Record<string, unknown>
  assert.deepEqual(normalized.__proto__, { controlled: true })
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype)
  assert.equal((Object.prototype as { controlled?: boolean }).controlled, undefined)
})

test('JSON normalization rejects values that would be lossy or executable', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const accessor = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get: () => 'must not execute',
  })
  const sparse = Array(1)
  const symbolKeyed = { value: 'ok', [Symbol('hidden')]: 'hidden' }

  for (const value of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Symbol('value'),
    () => undefined,
    new Date(),
    new Map(),
    circular,
    accessor,
    sparse,
    symbolKeyed,
  ]) {
    assert.throws(() => toJson(value), TypeError)
  }
})

test('JSON normalization enforces depth and collection limits', () => {
  let deep: unknown = 'leaf'
  for (let depth = 0; depth < 34; depth += 1) deep = { child: deep }

  assert.throws(() => toJson(deep), /maximum depth/)
  assert.throws(() => toJson(new Array(10_001).fill(null)), /array exceeds the maximum size/)
  assert.throws(
    () => toJson(Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [index, null]))),
    /object exceeds the maximum size/,
  )
})
