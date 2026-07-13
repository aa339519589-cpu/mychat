import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestError } from '../lib/api/request'
import {
  generateTitleText,
  normalizeGeneratedTitle,
  validateTitleGenerationRequest,
} from '../lib/chat/title-generation'
import type { ChatModelSelection } from '../lib/chat/model-selection'

const request = {
  conversationId: '10000000-0000-4000-8000-000000000001',
  userText: '怎么让任务可靠运行？',
  assistantText: '可以使用租约和 fencing token。',
}

const selection = {
  customEndpoint: false,
  model: 'model',
  thinking: true,
  capability: {
    id: 'model',
    supportsThinking: true,
    supportsImageInput: false,
    provider: { id: 'provider', baseUrl: 'https://model.example/v1', adapter: 'openai' },
  },
  apiKey: 'secret',
  outputKind: 'chat',
} as unknown as ChatModelSelection

test('title request validation rejects invalid identity and oversized source', () => {
  assert.throws(
    () => validateTitleGenerationRequest({ ...request, conversationId: 'bad' }),
    (error: unknown) => error instanceof RequestError && error.status === 400,
  )
  assert.throws(
    () => validateTitleGenerationRequest({ ...request, userText: 'x'.repeat(2_001) }),
    (error: unknown) => error instanceof RequestError && error.status === 413,
  )
})

test('title generation is a one-round, tool-free and bounded model call', async () => {
  const result = await generateTitleText({
    request,
    selection,
    signal: new AbortController().signal,
  }, {
    runAgentLoop: async options => {
      assert.deepEqual(options.tools, [])
      assert.equal(options.maxRounds, 1)
      assert.equal(options.thinking, false)
      assert.equal(options.turnOptions?.maxOutputTokens, 64)
      options.emit({ text: '「可靠生成架构。」\n' })
      return { totalTokens: 17 }
    },
  })
  assert.deepEqual(result, { title: '可靠生成架构', totalTokens: 17 })
})

test('generated title normalization strips framing and caps length', () => {
  assert.equal(normalizeGeneratedTitle('  “一二三四五六七八九十一二三四五六七八九十二三”  '), '一二三四五六七八九十一二三四五六七八九十')
})
