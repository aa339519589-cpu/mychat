import type { Json } from './database.types'

const MAX_JSON_DEPTH = 32
const MAX_JSON_COLLECTION_SIZE = 10_000
const MAX_JSON_NODE_COUNT = 100_000

type NormalizationState = {
  active: WeakSet<object>
  nodes: number
}

function normalizeJson(value: unknown, depth: number, state: NormalizationState): Json {
  if (depth > MAX_JSON_DEPTH) throw new TypeError('JSON value exceeds the maximum depth')
  state.nodes += 1
  if (state.nodes > MAX_JSON_NODE_COUNT) throw new TypeError('JSON value exceeds the maximum size')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON numbers must be finite')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_COLLECTION_SIZE) {
      throw new TypeError('JSON array exceeds the maximum size')
    }
    if (state.active.has(value)) throw new TypeError('JSON value contains a circular reference')
    state.active.add(value)
    try {
      const result: Json[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor)) {
          throw new TypeError('JSON arrays must contain concrete values')
        }
        result.push(normalizeJson(descriptor.value, depth + 1, state))
      }
      return result
    } finally {
      state.active.delete(value)
    }
  }
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JSON objects must be plain objects')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('JSON objects cannot contain symbol keys')
    }
    if (state.active.has(value)) throw new TypeError('JSON value contains a circular reference')
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value))
      .filter(([, descriptor]) => descriptor.enumerable)
    if (entries.length > MAX_JSON_COLLECTION_SIZE) {
      throw new TypeError('JSON object exceeds the maximum size')
    }
    state.active.add(value)
    const result: { [key: string]: Json } = {}
    try {
      for (const [key, descriptor] of entries) {
        if (!('value' in descriptor)) throw new TypeError('JSON objects cannot contain accessors')
        if (descriptor.value === undefined) continue
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: normalizeJson(descriptor.value, depth + 1, state),
          writable: true,
        })
      }
      return result
    } finally {
      state.active.delete(value)
    }
  }
  throw new TypeError('Value is not JSON serializable')
}

export function toJson(value: unknown): Json {
  return normalizeJson(value, 0, { active: new WeakSet(), nodes: 0 })
}

export function jsonRecord(value: Json | null | undefined): Record<string, unknown> | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
