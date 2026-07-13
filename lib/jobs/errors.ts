import type { JobErrorClass, JobFailure, JsonObject, JsonValue } from './contracts'

export const JOB_ERROR_CODES = [
  'JOB_INVALID_INPUT',
  'JOB_NOT_FOUND',
  'JOB_CONFLICT',
  'JOB_LEASE_STALE',
  'JOB_CANCEL_REQUESTED',
  'JOB_ATTEMPTS_EXHAUSTED',
  'JOB_RETRY_UNSAFE',
  'JOB_HANDLER_UNAVAILABLE',
  'JOB_DEPENDENCY_UNAVAILABLE',
  'JOB_TIMEOUT',
  'JOB_WORKER_SHUTDOWN',
  'JOB_INTERNAL',
] as const

export type JobErrorCode = typeof JOB_ERROR_CODES[number]

type JobRuntimeErrorOptions = {
  retryable?: boolean
  class?: JobErrorClass
  details?: JsonObject
  cause?: unknown
}

const ERROR_DEFAULTS: Record<JobErrorCode, { retryable: boolean; class: JobErrorClass }> = {
  JOB_INVALID_INPUT: { retryable: false, class: 'user' },
  JOB_NOT_FOUND: { retryable: false, class: 'user' },
  JOB_CONFLICT: { retryable: false, class: 'user' },
  JOB_LEASE_STALE: { retryable: false, class: 'internal' },
  JOB_CANCEL_REQUESTED: { retryable: false, class: 'user' },
  JOB_ATTEMPTS_EXHAUSTED: { retryable: false, class: 'internal' },
  JOB_RETRY_UNSAFE: { retryable: false, class: 'internal' },
  JOB_HANDLER_UNAVAILABLE: { retryable: false, class: 'internal' },
  JOB_DEPENDENCY_UNAVAILABLE: { retryable: true, class: 'internal' },
  JOB_TIMEOUT: { retryable: true, class: 'internal' },
  JOB_WORKER_SHUTDOWN: { retryable: true, class: 'internal' },
  JOB_INTERNAL: { retryable: false, class: 'internal' },
}

export class JobRuntimeError extends Error {
  readonly code: JobErrorCode
  readonly retryable: boolean
  readonly errorClass: JobErrorClass
  readonly details: JsonObject

  constructor(code: JobErrorCode, message: string, options: JobRuntimeErrorOptions = {}) {
    super(message, { cause: options.cause })
    this.name = 'JobRuntimeError'
    this.code = code
    this.retryable = options.retryable ?? ERROR_DEFAULTS[code].retryable
    this.errorClass = options.class ?? ERROR_DEFAULTS[code].class
    this.details = options.details ?? {}
  }

  toFailure(): JobFailure {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      class: this.errorClass,
      details: this.details,
    }
  }
}

export function isJobRuntimeError(value: unknown): value is JobRuntimeError {
  return value instanceof JobRuntimeError
}

function safeErrorDetails(value: unknown): JsonObject {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const details: JsonObject = {}
  for (const key of ['code', 'name', 'status']) {
    const entry = source[key]
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      details[key] = entry as JsonValue
    }
  }
  return details
}

export function normalizeJobError(error: unknown): JobRuntimeError {
  if (isJobRuntimeError(error)) return error
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new JobRuntimeError('JOB_TIMEOUT', 'Job operation timed out', { cause: error })
  }
  return new JobRuntimeError('JOB_INTERNAL', 'Job execution failed', {
    cause: error,
    details: safeErrorDetails(error),
  })
}
