import {
  isJobStatus,
  isJsonValue,
  type JobErrorClass,
  type JobFailure,
  type JobStatus,
  type JsonObject,
  type JsonValue,
} from './contracts'
import { JobRuntimeError } from './errors'

export function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function integerOf(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null
}

export function nullableInteger(value: unknown): number | null {
  return value == null ? null : integerOf(value)
}

export function statusOf(value: unknown): JobStatus | null {
  return isJobStatus(value) ? value : null
}

export function jsonOf(value: unknown, fallback: JsonValue): JsonValue {
  return isJsonValue(value) ? value : fallback
}

export function jsonObjectOf(value: unknown): JsonObject {
  const parsed = jsonOf(value, {})
  return !Array.isArray(parsed) && parsed !== null && typeof parsed === 'object' ? parsed : {}
}

export function failureOf(source: Record<string, unknown>): JobFailure | null {
  const nested = objectOf(source.error)
  const code = nested?.code ?? source.errorCode
  const errorClass = nested?.class ?? nested?.errorClass ?? source.errorClass
  if (typeof code !== 'string' || code.length === 0) return null
  const validClass: JobErrorClass = errorClass === 'retryable' || errorClass === 'user'
    || errorClass === 'provider' || errorClass === 'policy' || errorClass === 'internal'
    ? errorClass
    : 'internal'
  return {
    code,
    message: typeof nested?.message === 'string' ? nested.message : code,
    retryable: typeof nested?.retryable === 'boolean'
      ? nested.retryable
      : validClass === 'retryable' || validClass === 'provider',
    class: validClass,
    details: jsonObjectOf(nested?.details),
  }
}

export function malformed(name: string): never {
  throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Job repository returned malformed data', {
    details: { rpc: name },
  })
}
