import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BILLING_PRICE_VERSION,
  platformMediaUsage,
  platformModelCostMicros,
} from '../lib/jobs/pricing'

test('platform pricing is versioned, nonzero and bounded by admission catalog quotes', () => {
  assert.equal(BILLING_PRICE_VERSION, 1)
  assert.equal(platformModelCostMicros(480_000), 1_440_000)
  assert.deepEqual(platformMediaUsage('image'), {
    weightedTokens: 200_000,
    costMicros: 250_000,
    priceVersion: 1,
  })
  assert.deepEqual(platformMediaUsage('video'), {
    weightedTokens: 5_000_000,
    costMicros: 10_000_000,
    priceVersion: 1,
  })
})

test('customer-funded endpoints never consume platform quota or cost', () => {
  assert.equal(platformModelCostMicros(480_000, true), 0)
  assert.deepEqual(platformMediaUsage('image', true), {
    weightedTokens: 0,
    costMicros: 0,
    priceVersion: 1,
  })
})
