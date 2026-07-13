import assert from 'node:assert/strict'
import test from 'node:test'
import { extractImagePrompt } from '../lib/image-intent'

test('extractImagePrompt strips soft prefixes', () => {
  assert.equal(extractImagePrompt('画一只在月球喝咖啡的猫'), '一只在月球喝咖啡的猫')
  assert.equal(extractImagePrompt('generate an image of a red apple'), 'a red apple')
})
