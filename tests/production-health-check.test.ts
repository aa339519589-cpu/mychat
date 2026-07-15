import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeReadyUrl,
  validateReadyPayload,
} from '../scripts/check-production-health.mjs'

function readyPayload() {
  return {
    status: 'ok',
    ready: true,
    revision: 'abcdef012345',
    checks: Object.fromEntries([
      'auth',
      'database',
      'distributedRateLimit',
      'queue',
      'worker',
      'stream',
      'observability',
      'sandbox',
    ].map(name => [name, { configured: true, ready: true }])),
  }
}

test('production health verifier accepts only the exact ready endpoint', () => {
  assert.equal(
    normalizeReadyUrl('https://mychat.example/api/ready').href,
    'https://mychat.example/api/ready',
  )
  assert.equal(
    normalizeReadyUrl('http://127.0.0.1:3000/api/ready').href,
    'http://127.0.0.1:3000/api/ready',
  )
  assert.throws(() => normalizeReadyUrl('https://mychat.example/api/live'), /exact \/api\/ready/)
  assert.throws(() => normalizeReadyUrl('http://mychat.example/api/ready'), /require HTTPS/)
  assert.throws(() => normalizeReadyUrl('https://user:pass@mychat.example/api/ready'), /exact \/api\/ready/)
})

test('production health verifier requires every configured and ready dependency', () => {
  const ready = readyPayload()
  ;(ready.checks.worker as { draining?: boolean }).draining = false
  assert.deepEqual(validateReadyPayload(ready), { revision: 'abcdef012345' })
  assert.deepEqual(validateReadyPayload(ready, 'abcdef0'), { revision: 'abcdef012345' })

  ;(ready.checks.worker as { draining?: boolean }).draining = true
  assert.deepEqual(validateReadyPayload(ready, 'abcdef0', true), { revision: 'abcdef012345' })
  ;(ready.checks.worker as { draining?: boolean }).draining = false

  const noWorker = readyPayload()
  noWorker.checks.worker.ready = false
  assert.throws(() => validateReadyPayload(noWorker), /worker/)

  const drainingWorker = readyPayload()
  const drainingCheck = drainingWorker.checks.worker as {
    configured: boolean
    ready: boolean
    draining?: boolean
  }
  drainingCheck.draining = true
  assert.throws(() => validateReadyPayload(drainingWorker), /draining/)

  const unidentifiedDrainState = readyPayload()
  assert.throws(() => validateReadyPayload(unidentifiedDrainState), /drain state/)

  const noStreamKey = readyPayload()
  ;(noStreamKey.checks.worker as { draining?: boolean }).draining = false
  noStreamKey.checks.stream.configured = false
  assert.throws(() => validateReadyPayload(noStreamKey), /stream/)

  const noObservability = readyPayload()
  ;(noObservability.checks.worker as { draining?: boolean }).draining = false
  noObservability.checks.observability.ready = false
  assert.throws(() => validateReadyPayload(noObservability), /observability/)

  const unknownRevision = readyPayload()
  ;(unknownRevision.checks.worker as { draining?: boolean }).draining = false
  unknownRevision.revision = 'unknown'
  assert.throws(() => validateReadyPayload(unknownRevision), /Git revision/)

  assert.throws(() => validateReadyPayload(ready, '1234567'), /expected deployment/)
  assert.throws(
    () => validateReadyPayload({ ...ready, ready: false }),
    /strict readiness/,
  )
})
