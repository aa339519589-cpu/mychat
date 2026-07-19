import assert from 'node:assert/strict'
import test from 'node:test'
import { RequestError } from '../lib/api/request'
import { requireDurableChatIdentity, validateChatRequest } from '../lib/llm/chat-request'

const identity = {
  conversationId: '10000000-0000-4000-8000-000000000001',
  userMessageId: '15000000-0000-4000-8000-000000000001',
  generationId: '20000000-0000-4000-8000-000000000001',
  assistantMessageId: '30000000-0000-4000-8000-000000000001',
}

test('general chat requires one complete durable generation identity', () => {
  const complete = validateChatRequest({ messages: [{ role: 'user', content: 'hello' }], ...identity })
  assert.doesNotThrow(() => requireDurableChatIdentity(complete))

  for (const partial of [
    {},
    { conversationId: identity.conversationId },
    { ...identity, assistantMessageId: undefined },
  ]) {
    const body = validateChatRequest({ messages: [{ role: 'user', content: 'hello' }], ...partial })
    assert.throws(
      () => requireDurableChatIdentity(body),
      (error: unknown) => error instanceof RequestError && error.status === 400,
    )
  }
})

function rejects(input: unknown, message: RegExp): void {
  assert.throws(
    () => validateChatRequest(input),
    (error: unknown) => error instanceof RequestError && error.status >= 400 && message.test(error.message),
  )
}

test('chat request boundary rejects malformed and oversized nested input', () => {
  const base = { messages: [{ role: 'user', content: 'hello' }] }
  const attachment = { name: 'x', dataUrl: '', isPdf: false }
  rejects(null, /请求体格式错误/)
  rejects([], /请求体格式错误/)
  rejects({}, /messages 不能为空/)
  rejects({ messages: Array.from({ length: 501 }, () => ({ role: 'user', content: 'x' })) }, /消息数量过多/)
  rejects({ messages: [null] }, /消息格式无效/)
  rejects({ messages: [{ role: 'system', content: 'x' }] }, /消息角色无效/)
  rejects({ messages: [{ role: 'user', content: 1 }] }, /消息内容格式无效/)
  rejects({ messages: [{ role: 'user', content: Array.from({ length: 21 }, () => ({ type: 'text', text: 'x' })) }] }, /消息内容分段过多/)
  rejects({ messages: [{ role: 'user', content: [null] }] }, /消息内容分段无效/)
  rejects({ messages: [{ role: 'user', content: [{ type: 'audio', text: 'x' }] }] }, /不支持的分段/)
  rejects({ messages: [{ role: 'user', content: 'x'.repeat(100_001) }] }, /单条消息过长/)
  rejects({ messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'x'.repeat(100_000) })) }, /消息上下文过大/)
  rejects({ messages: [{ role: 'user', content: 'x', images: Array(9).fill('https://example.com/image.png') }] }, /消息图片格式无效/)
  rejects({ messages: [{ role: 'user', content: 'x', images: 'https://example.com/image.png' }] }, /消息图片格式无效/)
  rejects({ messages: [{ role: 'user', content: 'x', images: ['file:///tmp/image.png'] }] }, /消息图片格式无效/)
  rejects({ messages: [{ role: 'user', content: 'x', images: [`data:image/png;base64,${'A'.repeat(8_000_001)}`] }] }, /单张图片过大/)
  rejects({ messages: [{ role: 'user', content: 'x', imageSummary: 1 }] }, /图片摘要格式无效/)

  rejects({ ...base, attachments: {} }, /附件数量无效/)
  rejects({ ...base, attachments: Array(9).fill({ name: 'x' }) }, /附件数量无效/)
  rejects({ ...base, attachments: [null] }, /附件格式无效/)
  rejects({ ...base, attachments: [{ ...attachment, name: 1 }] }, /附件名称无效/)
  rejects({ ...base, attachments: [{ name: 'x' }] }, /附件格式无效/)
  rejects({ ...base, attachments: [{ ...attachment, text: 1 }] }, /附件文本格式无效/)
  rejects({ ...base, attachments: [{ ...attachment, text: 'x'.repeat(80_001) }] }, /单个附件文本过大/)
  rejects({ ...base, attachments: Array.from({ length: 3 }, (_, index) => ({ ...attachment, name: `${index}.txt`, text: 'x'.repeat(60_000) })) }, /附件文本总量过大/)
  rejects({ ...base, attachments: [{ ...attachment, name: 'scan.pdf', isPdf: true, pageImages: ['bad'] }] }, /扫描件图片格式无效/)
  rejects({ ...base, attachments: [{ ...attachment, name: 'scan.pdf', isPdf: true, pageImages: Array(19).fill('https://example.com/page.png') }] }, /扫描件最多支持 18 页/)

  rejects({ ...base, memories: {} }, /记忆数据无效/)
  rejects({ ...base, memories: Array.from({ length: 201 }, (_, index) => ({ id: `${index}`, content: 'x' })) }, /记忆数据无效/)
  rejects({ ...base, memories: [{ id: 'm', content: 1 }] }, /记忆内容无效/)
  rejects({ ...base, memories: [{ id: 'm', content: 'x'.repeat(10_001) }] }, /记忆内容无效/)
  rejects({ ...base, memories: [{ id: 'm', content: 'x', timestamp: 1 }] }, /记忆内容无效/)
  rejects({ ...base, project: null }, /项目数据无效/)
  rejects({ ...base, project: { id: 'x'.repeat(129) } }, /项目数据无效/)
  rejects({ ...base, project: { id: 'p', instructions: 1, files: [], projectMemories: [] } }, /项目指令格式无效/)
  rejects({ ...base, project: { id: 'p', instructions: '', files: {}, projectMemories: [] } }, /项目资料格式无效/)
  rejects({ ...base, project: { id: 'p', instructions: '', files: [], projectMemories: {} } }, /项目记忆格式无效/)
  rejects({ ...base, project: { id: 'p', instructions: 'x'.repeat(50_001), files: [], projectMemories: [] } }, /项目指令过长/)
  rejects({ ...base, project: { id: 'p', instructions: '', files: [{ name: 1, content: 'x' }], projectMemories: [] } }, /项目资料格式无效/)
  rejects({ ...base, project: { id: 'p', instructions: '', files: Array.from({ length: 31 }, (_, index) => ({ name: `${index}`, content: 'x' })), projectMemories: [] } }, /项目资料过大/)
  rejects({ ...base, project: { id: 'p', instructions: '', files: Array.from({ length: 5 }, (_, index) => ({ name: `${index}`, content: 'x'.repeat(170_000) })), projectMemories: [] } }, /项目资料过大/)
  rejects({ ...base, project: { id: 'p', instructions: '', files: [], projectMemories: [{ id: 'm', content: 1 }] } }, /项目记忆格式无效/)
  rejects({ ...base, project: { id: 'p', instructions: '', files: [], projectMemories: Array.from({ length: 201 }, (_, index) => ({ id: `${index}`, content: 'x' })) } }, /项目记忆格式无效/)

  for (const field of ['conversationId', 'endpointId', 'userMessageId', 'generationId', 'assistantMessageId'] as const) {
    rejects({ ...base, [field]: 'invalid' }, new RegExp(`${field} 无效`))
  }
  rejects({ ...base, generateImage: 'yes' }, /generateImage 无效/)
  rejects({ ...base, generateVideo: 'yes' }, /generateVideo 无效/)
  rejects({ ...base, tier: 'unknown' }, /tier 无效/)
  rejects({ ...base, searchMode: 'unknown' }, /searchMode 无效/)
  rejects({ ...base, deepResearch: 'yes' }, /deepResearch 无效/)
  rejects({ ...base, historyRetrieval: 'yes' }, /historyRetrieval 无效/)
  rejects({ ...base, messages: [{ role: 'user', content: 'x', ts: 'not-a-date' }] }, /消息时间无效/)
  rejects({ ...base, turn: { schemaVersion: 2 } }, /turn 无效/)
  rejects({ ...base, turn: {
    schemaVersion: 2,
    operation: 'replace-assistant',
    expectedTailMessageId: identity.assistantMessageId,
  } }, /turn 无效/)
  rejects({ ...base, turn: {
    schemaVersion: 2,
    operation: 'replace-assistant',
    expectedTailMessageId: identity.assistantMessageId,
    targetAssistantMessageId: identity.userMessageId,
  } }, /turn 无效/)
  rejects({ ...base, turn: {
    schemaVersion: 2,
    operation: 'replace-from-user',
    expectedTailMessageId: identity.assistantMessageId,
    targetAssistantMessageId: identity.assistantMessageId,
  } }, /turn 无效/)
})

test('chat request boundary accepts the complete supported payload', () => {
  const body = validateChatRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      ],
      images: ['https://example.com/image.png'],
      imageSummary: 'an image',
    }],
    attachments: [{ name: 'scan.pdf', dataUrl: '', isPdf: true, text: 'document', pageImages: ['https://example.com/page.png'] }],
    memories: [{ id: 'memory', content: 'preference', timestamp: '2026-07-13T00:00:00.000Z' }],
    project: {
      id: 'project',
      instructions: 'instructions',
      files: [{ name: 'README.md', content: 'content' }],
      projectMemories: [{ id: 'project-memory', content: 'context' }],
    },
    ...identity,
    endpointId: '40000000-0000-4000-8000-000000000001',
    tier: '正构',
    searchMode: 'web',
    deepResearch: true,
    historyRetrieval: true,
    generateImage: false,
    generateVideo: false,
    turn: {
      schemaVersion: 1,
      createConversation: true,
      title: '未命名的篇章',
      projectId: null,
    },
  })
  assert.equal(body.messages.length, 1)
  assert.equal(body.attachments?.length, 1)
  assert.equal(body.project?.files.length, 1)
})

test('chat request boundary accepts both fenced regeneration operations', () => {
  const replaceAssistant = validateChatRequest({
    messages: [{ id: identity.userMessageId, role: 'user', content: 'hello' }],
    ...identity,
    turn: {
      schemaVersion: 2,
      operation: 'replace-assistant',
      expectedTailMessageId: identity.assistantMessageId,
      targetAssistantMessageId: identity.assistantMessageId,
    },
  })
  assert.equal(replaceAssistant.turn?.schemaVersion, 2)

  const replaceFromUser = validateChatRequest({
    messages: [{ id: identity.userMessageId, role: 'user', content: 'edited' }],
    ...identity,
    turn: {
      schemaVersion: 2,
      operation: 'replace-from-user',
      expectedTailMessageId: identity.assistantMessageId,
    },
  })
  assert.deepEqual(replaceFromUser.turn, {
    schemaVersion: 2,
    operation: 'replace-from-user',
    expectedTailMessageId: identity.assistantMessageId,
  })
})
