import assert from 'node:assert/strict'
import test from 'node:test'
import { extractImagePrompt, isImageGenerationIntent } from '../lib/image-intent'

test('detects chinese image intents', () => {
  assert.equal(isImageGenerationIntent('画一只猫'), true)
  assert.equal(isImageGenerationIntent('帮我生成一张海报，赛博朋克风格'), true)
  assert.equal(isImageGenerationIntent('文生图：海边日落'), true)
})

test('detects english image intents', () => {
  assert.equal(isImageGenerationIntent('generate an image of a red apple'), true)
  assert.equal(isImageGenerationIntent('draw me a dragon'), true)
})

test('does not flag normal chat', () => {
  assert.equal(isImageGenerationIntent('你是谁'), false)
  assert.equal(isImageGenerationIntent('解释一下这张图表的含义'), false)
})

test('extractImagePrompt strips soft prefixes', () => {
  assert.equal(extractImagePrompt('画一只在月球喝咖啡的猫'), '一只在月球喝咖啡的猫')
  assert.equal(extractImagePrompt('generate an image of a red apple'), 'a red apple')
})
