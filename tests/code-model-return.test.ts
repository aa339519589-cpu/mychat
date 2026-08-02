import assert from 'node:assert/strict'
import test from 'node:test'
import { finalCodeTaskStatus } from '../lib/code-agent/runtime'
import { buildCodeSystem } from '../lib/code-agent/system-prompt'
import type { ChatEvent } from '../lib/llm/events'
import { openRouterModelCapability } from '../lib/llm/models'
import { buildProviderRequest } from '../lib/llm/provider-adapters'
import { TurnAccumulator } from '../lib/llm/turn-accumulator'
import type { ModelCatalogItem } from '../lib/model-catalog'

function openRouterModel(): ModelCatalogItem {
  return {
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5',
    provider: 'OpenAI',
    access: 'premium',
    outputKind: 'chat',
    promptPrice: 0,
    completionPrice: 0,
    contextLength: 128_000,
    vision: false,
    tools: true,
    flagship: true,
    reasoningEfforts: ['high', 'none'],
    defaultReasoningEffort: 'high',
    reasoningMandatory: false,
  }
}

test('OpenRouter Code requests use the dedicated adapter and canonical options', () => {
  assert.equal(openRouterModelCapability(openRouterModel()).provider.adapter, 'openrouter-openai')
  const request = buildProviderRequest('openrouter-openai', {
    model: 'openai/gpt-5.5',
    messages: [{ role: 'user', content: '修复代码' }],
    tools: [{ type: 'function', function: { name: 'read_file' } }],
    thinking: true,
    apiKey: 'test-key',
    reasoningEffort: 'high',
    maxOutputTokens: 40_000,
  })
  assert.deepEqual(request.body.reasoning, { effort: 'high' })
  assert.equal(request.body.reasoning_effort, undefined)
  assert.equal(request.body.max_completion_tokens, 40_000)
  assert.equal(request.body.max_tokens, undefined)
  assert.deepEqual(request.body.stream_options, { include_usage: true })
  assert.equal(request.body.tool_choice, 'auto')
})

test('OpenRouter reasoning details survive a tool-call round', () => {
  const events: ChatEvent[] = []
  const accumulator = new TurnAccumulator({
    generic: true,
    model: 'openai/gpt-5.5',
    emit: event => events.push(event),
    timingEnabled: false,
    startedAt: 0,
    deferTextUntilTurnEnd: true,
  })
  const reasoningDetails = [{ type: 'reasoning.text', text: 'inspect the repository' }]
  accumulator.handle({
    choices: [{
      delta: {
        reasoning_details: reasoningDetails,
        tool_calls: [{
          index: 0,
          id: 'call-1',
          function: { name: 'read_file', arguments: '{"path":"package.json"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  })
  const result = accumulator.finish({ sawDone: true, callerLimitReached: false })
  assert.equal(result.failed, false)
  assert.equal(result.toolCalls[0]?.name, 'read_file')
  assert.deepEqual(result.assistantMessage?.reasoning_details, reasoningDetails)
})

test('OpenRouter mid-stream errors become failed turns', () => {
  const accumulator = new TurnAccumulator({
    generic: true,
    model: 'openai/gpt-5.5',
    emit: () => undefined,
    timingEnabled: false,
    startedAt: 0,
    deferTextUntilTurnEnd: true,
  })
  accumulator.handle({
    error: { code: 'server_error', message: 'Provider disconnected unexpectedly' },
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
  })
  const result = accumulator.finish({ sawDone: true, callerLimitReached: false })
  assert.equal(result.failed, true)
  assert.match(result.error ?? '', /Provider disconnected unexpectedly/)
  assert.equal(result.assistantMessage, null)
  assert.deepEqual(result.toolCalls, [])
})

test('complete Plan output waits for confirmation instead of failing internally', () => {
  assert.equal(finalCodeTaskStatus(false, {
    workspace: false,
    completed: false,
    waitingForUser: false,
    published: false,
    plannedRepo: true,
    plannedFiles: 2,
  }), 'waiting_for_user')
  assert.equal(finalCodeTaskStatus(false, {
    workspace: true,
    completed: false,
    waitingForUser: false,
    published: false,
    plannedRepo: true,
    plannedFiles: 2,
  }), 'running')
  const prompt = buildCodeSystem('GPT-5.5', null, 'bo', [], 'plan', false)
  assert.match(prompt, /计划完整后调用 complete/)
})
