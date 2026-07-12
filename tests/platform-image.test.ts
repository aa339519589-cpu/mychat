import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDeepTierImageConfig } from '../lib/llm/models'

test('resolveDeepTierImageConfig reads env', () => {
  process.env.DEEP_TIER_BASE_URL = 'https://proxy.example/v1'
  process.env.DEEP_TIER_API_KEY = 'sk-test'
  process.env.DEEP_TIER_IMAGE_MODEL = 'my-image-model'
  const cfg = resolveDeepTierImageConfig()
  assert.ok(cfg)
  assert.equal(cfg!.model, 'my-image-model')
  assert.equal(cfg!.baseUrl, 'https://proxy.example/v1')
  delete process.env.DEEP_TIER_IMAGE_MODEL
  process.env.DEEP_TIER_MODEL = 'grok-4.5'
  const cfg2 = resolveDeepTierImageConfig()
  assert.equal(cfg2!.model, 'grok-4.5')
})
