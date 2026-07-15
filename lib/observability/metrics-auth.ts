import { timingSafeEqual } from 'node:crypto'

type MetricsEnvironment = {
  NODE_ENV?: string
  METRICS_BEARER_TOKEN?: string
}

const MINIMUM_SECRET_BYTES = 32
const MAXIMUM_ENCODED_LENGTH = 512

function decodedSecretBytes(value: string): number {
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    return value.length / 2
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return 0
  try {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').byteLength
  } catch {
    return 0
  }
}

/** Accept only an encoded secret containing at least 256 bits of key material. */
export function metricsBearerToken(
  environment: MetricsEnvironment = process.env,
): string | null {
  const value = environment.METRICS_BEARER_TOKEN?.trim()
  if (!value || value.length > MAXIMUM_ENCODED_LENGTH) return null
  return decodedSecretBytes(value) >= MINIMUM_SECRET_BYTES ? value : null
}

export function metricsRequestAuthorized(
  authorization: string | null,
  environment: MetricsEnvironment = process.env,
): boolean {
  const expected = metricsBearerToken(environment)
  const received = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : ''
  if (!expected || !received) return false
  const left = Buffer.from(expected)
  const right = Buffer.from(received)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function assertProductionMetricsBearerToken(
  environment: MetricsEnvironment = process.env,
): void {
  if (environment.NODE_ENV === 'production' && !metricsBearerToken(environment)) {
    throw new Error('Production metrics authentication is not securely configured')
  }
}
