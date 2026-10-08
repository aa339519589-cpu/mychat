import test from 'node:test'
import assert from 'node:assert/strict'
import { loadChatUserProfile } from '../lib/chat/user-system-prompt'
import { loadGlobalMemories } from '../lib/chat/authoritative-context-memory'

test('one owned profile read supplies prompt and memory preferences without another profile RTT', async () => {
  const reads: string[] = []
  const client = { from(table: string) {
    reads.push(table)
    return { select: () => ({ eq: (_field: string, id: string) => ({ maybeSingle: async () => ({
      data: { user_id: id, custom_system_prompt: ' 保留用户规则 ', memory_enabled: false, sensitive_memory_enabled: false }, error: null,
    }) }) }) }
  } } as never
  const profile = loadChatUserProfile(client, 'owner')
  const [prompt, memories] = await Promise.all([
    profile.then(value => value.customSystemPrompt),
    loadGlobalMemories(client, 'owner', true, profile.then(value => value.preferences)),
  ])
  assert.equal(prompt, '保留用户规则')
  assert.deepEqual(memories, { enabled: false, sensitiveEnabled: false, memories: [] })
  assert.deepEqual(reads, ['profiles'])
})

test('prefetched profile never accepts another owner or an unavailable dependency', async () => {
  for (const value of [{ data: { user_id: 'another' }, error: null }, { data: null, error: { code: 'offline' } }]) {
    const client = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => value }) }) }) } as never
    await assert.rejects(loadChatUserProfile(client, 'owner'), /上下文暂时不可用/)
  }
})
