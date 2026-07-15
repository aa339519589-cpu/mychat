import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertProductionMetricsBearerToken,
  metricsBearerToken,
  metricsRequestAuthorized,
} from '../lib/observability/metrics-auth'

const hexSecret = '0123456789abcdef'.repeat(4)
const base64UrlSecret = Buffer.alloc(32, 0x5a).toString('base64url')

test('metrics authentication accepts only encoded secrets with at least 256 bits', () => {
  assert.equal(metricsBearerToken({ METRICS_BEARER_TOKEN: hexSecret }), hexSecret)
  assert.equal(metricsBearerToken({ METRICS_BEARER_TOKEN: base64UrlSecret }), base64UrlSecret)
  assert.equal(metricsBearerToken({ METRICS_BEARER_TOKEN: 'a'.repeat(32) }), null)
  assert.equal(metricsBearerToken({ METRICS_BEARER_TOKEN: 'not valid secret material!' }), null)
  assert.equal(metricsBearerToken({}), null)
})

test('metrics request authentication is fail-closed and uses exact bearer bytes', () => {
  const environment = { METRICS_BEARER_TOKEN: hexSecret }
  assert.equal(metricsRequestAuthorized(`Bearer ${hexSecret}`, environment), true)
  assert.equal(metricsRequestAuthorized(hexSecret, environment), false)
  assert.equal(metricsRequestAuthorized(`Bearer ${hexSecret.slice(0, -1)}0`, environment), false)
  assert.equal(metricsRequestAuthorized(null, environment), false)
  assert.equal(metricsRequestAuthorized(`Bearer ${hexSecret}`, {
    METRICS_BEARER_TOKEN: 'weak',
  }), false)
})

test('production prestart rejects a missing or weak metrics secret', () => {
  assert.doesNotThrow(() => assertProductionMetricsBearerToken({ NODE_ENV: 'development' }))
  assert.doesNotThrow(() => assertProductionMetricsBearerToken({
    NODE_ENV: 'production',
    METRICS_BEARER_TOKEN: hexSecret,
  }))
  assert.throws(
    () => assertProductionMetricsBearerToken({ NODE_ENV: 'production' }),
    /not securely configured/,
  )
  assert.throws(() => assertProductionMetricsBearerToken({
    NODE_ENV: 'production',
    METRICS_BEARER_TOKEN: 'too-short',
  }), /not securely configured/)
})
