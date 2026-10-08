import assert from 'node:assert/strict'
import test from 'node:test'
import { CURATED_OPENROUTER_MODELS } from '../lib/model-catalog'

test('Haiku 5.5 is a first-class flagship like Sonnet 5.5', () => {
  const sonnet = CURATED_OPENROUTER_MODELS.find(model => model.id === 'anthropic/claude-sonnet-5.5')
  const haiku = CURATED_OPENROUTER_MODELS.find(model => model.id === 'anthropic/claude-haiku-5.5')

  assert.equal(sonnet?.access, 'premium')
  assert.equal(sonnet?.flagship, true)
  assert.deepEqual(haiku, {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    provider: 'Anthropic',
    access: 'premium',
    flagship: true,
  })
})
