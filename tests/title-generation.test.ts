import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatModelSelection } from '../lib/chat/model-selection'
import {
  generateTitleText,
  validateTitleGenerationRequest,
} from '../lib/chat/title-generation'
import { customModelCapability } from '../lib/llm/models'
import type { AgentLoopOpts } from '../lib/llm/agent-loop'

const conversationId = '87000000-0000-4000-8000-000000000002'

function selection(model: string): ChatModelSelection {
  return {
    customEndpoint: true,
    model,
    thinking: false,
    reasoningEffort: null,
    accessClass: 'legacy',
    capability: customModelCapability(model, 'https://kuaipao.pro/v1'),
    apiKey: 'secret',
    authType: 'bearer',
    outputKind: 'chat',
    endpointDisplayName: model,
  }
}

async function capturedTitleOptions(model: string): Promise<AgentLoopOpts> {
  let captured: AgentLoopOpts | null = null
  const request = validateTitleGenerationRequest({
    conversationId,
    userText: '用户问题',
    assistantText: '模型回答',
  })
  const result = await generateTitleText({
    request,
    selection: selection(model),
    signal: new AbortController().signal,
  }, {
    runAgentLoop: async options => {
      captured = options
      options.emit({ text: '测试标题' })
      return { totalTokens: 7 }
    },
  })
  assert.equal(result.title, '测试标题')
  assert.equal(result.totalTokens, 7)
  assert.ok(captured)
  return captured
}

function outputLimit(options: AgentLoopOpts): number | undefined {
  return options.turnOptions?.maxOutputTokens
}

test('title request accepts canonical UUIDs and rejects malformed IDs', () => {
  const parsed = validateTitleGenerationRequest({
    conversationId,
    endpointId: '87000000-0000-4000-8000-000000000004',
    userText: 'u',
    assistantText: 'a',
  })
  assert.equal(parsed.conversationId, conversationId)
  assert.throws(() => validateTitleGenerationRequest({
    conversationId: '87000000-0000-4000-000000000002',
    userText: 'u',
    assistantText: 'a',
  }))
})

test('Sonnet 5 title generation explicitly disables optional thinking', async () => {
  const options = await capturedTitleOptions('claude-sonnet-5')
  assert.equal(options.adapter, 'anthropic-messages')
  assert.equal(options.reasoningEffort, 'none')
  assert.equal(outputLimit(options), 64)
})

test('Fable 5 title generation uses the lowest valid mandatory thinking level', async () => {
  const options = await capturedTitleOptions('claude-fable-5')
  assert.equal(options.adapter, 'anthropic-messages')
  assert.equal(options.reasoningEffort, 'low')
  assert.equal(outputLimit(options), 2_048)
})

test('Haiku 4.5 title generation keeps extended thinking off', async () => {
  const options = await capturedTitleOptions('claude-haiku-4-5')
  assert.equal(options.adapter, 'anthropic-messages')
  assert.equal(options.reasoningEffort, 'none')
  assert.equal(outputLimit(options), 64)
})
