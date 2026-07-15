import { requestId } from './request'

/**
 * Version 1 is intentionally small and transport-neutral.  Add fields only in a
 * new contract version so clients can branch on the header instead of parsing a
 * localized message.
 */
export const API_ERROR_CONTRACT_VERSION = '1' as const
export const API_ERROR_CONTRACT_HEADER = 'X-MyChat-Error-Contract'

export const API_ERROR_CODES = {
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
  INVALID_REQUEST: 'INVALID_REQUEST',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_DEPENDENCY_UNAVAILABLE: 'AUTH_DEPENDENCY_UNAVAILABLE',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  JOB_NOT_READY: 'JOB_NOT_READY',
  JOB_LEASE_STALE: 'JOB_LEASE_STALE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ApiErrorCode = typeof API_ERROR_CODES[keyof typeof API_ERROR_CODES]

export type ApiErrorV1 = {
  code: ApiErrorCode
  message: string
  retryable: boolean
  details: Readonly<Record<string, unknown>>
}

export type ApiErrorEnvelopeV1 = {
  error: ApiErrorV1
  request_id: string
}

export type ApiErrorResponseOptions = {
  status: number
  code: ApiErrorCode
  message: string
  retryable: boolean
  details?: Readonly<Record<string, unknown>>
  headers?: HeadersInit
}

function responseRequestId(request?: Request): string {
  return request ? requestId(request) : crypto.randomUUID()
}

/** Build the stable v1 error body without exposing an exception or stack. */
export function apiErrorEnvelopeV1(
  request: Request | undefined,
  error: Omit<ApiErrorResponseOptions, 'status' | 'headers'>,
): ApiErrorEnvelopeV1 {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details ?? {},
    },
    request_id: responseRequestId(request),
  }
}

/**
 * Return a no-store JSON error with a correlation id in both body and headers.
 * Callers must choose retryability explicitly; HTTP status alone is ambiguous.
 */
export function apiErrorResponseV1(
  request: Request | undefined,
  options: ApiErrorResponseOptions,
): Response {
  const body = apiErrorEnvelopeV1(request, options)
  const headers = new Headers(options.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set('X-Request-Id', body.request_id)
  headers.set(API_ERROR_CONTRACT_HEADER, API_ERROR_CONTRACT_VERSION)
  return Response.json(body, { status: options.status, headers })
}
