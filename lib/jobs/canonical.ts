import { createHash } from 'node:crypto'
import type { JsonValue } from './contracts'

const MAX_CANONICAL_DEPTH = 32

/** Stable JSON used for input fingerprints and provider idempotency keys. */
export function canonicalJobJson(value: JsonValue, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) throw new TypeError('Job input nesting is too deep')
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Job input contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalJobJson(entry, depth + 1)).join(',')}]`
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Job input contains a non-plain object')
  }
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJobJson(value[key], depth + 1)}`
  )).join(',')}}`
}

export function sha256JobValue(value: JsonValue): string {
  return createHash('sha256').update(canonicalJobJson(value), 'utf8').digest('hex')
}

export function sha256JobBytes(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}
