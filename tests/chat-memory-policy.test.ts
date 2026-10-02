import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { activeTools } from '../lib/tools'
import { buildSystem } from '../lib/llm/system'
import { resolveChatMemoryPolicy } from '../lib/jobs/handlers/chat-memory-policy'

test('an enabled global Memory is available to a selected custom model in main chat', () => {
  const memories = [{ id: 'memory-1', content: 'prefers concise answers' }]
  const policy = resolveChatMemoryPolicy({
    customEndpoint: true,
    memoryEnabled: true,
    inProject: false,
    memories,
  })
  assert.deepEqual(policy, {
    enabled: true,
    globalMemories: memories,
  })
  const system = buildSystem(policy.globalMemories, { memoryEnabled: policy.enabled, modelSource: 'custom' })
  assert.match(system, /<memory id="memory-1"/)
  assert.match(system, /prefers concise answers/)
  const tools = activeTools({ loggedIn: true, searchMode: 'off', memoryEnabled: policy.enabled, projectId: null })
  assert.ok(tools.some(tool => tool.name === 'remember'))
})

test('the account Memory switch still disables custom-model memory', () => {
  assert.deepEqual(resolveChatMemoryPolicy({
    customEndpoint: true,
    memoryEnabled: false,
    inProject: false,
    memories: [{ id: 'memory-1', content: 'private preference' }],
  }), {
    enabled: false,
    globalMemories: undefined,
  })
})

test('custom endpoints do not receive project memory or project memory tools', () => {
  assert.deepEqual(resolveChatMemoryPolicy({
    customEndpoint: true,
    memoryEnabled: true,
    inProject: true,
    memories: [{ id: 'memory-1', content: 'global preference' }],
  }), {
    enabled: false,
    globalMemories: undefined,
  })
})

test('platform project chats keep project memory tools without global memories', () => {
  assert.deepEqual(resolveChatMemoryPolicy({
    customEndpoint: false,
    memoryEnabled: true,
    inProject: true,
    memories: [{ id: 'memory-1', content: 'global preference' }],
  }), {
    enabled: true,
    globalMemories: undefined,
  })
})

test('chat tools and system prompt both consume the selected-model memory policy', () => {
  const source = readFileSync(new URL('../lib/jobs/handlers/chat-text.ts', import.meta.url), 'utf8')
  assert.equal((source.match(/const memoryPolicy = resolveChatMemoryPolicy\(/g) ?? []).length, 2)
  assert.match(source, /memoryEnabled:\s*memoryPolicy\.enabled/)
  assert.match(source, /memoryPolicy\.globalMemories/)
})
