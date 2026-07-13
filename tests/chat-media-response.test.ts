import assert from 'node:assert/strict'
import test from 'node:test'
import { createMediaGenerationResponse } from '../lib/chat/media-response'
import { MediaGenerationError } from '../lib/llm/media-generation'

function ssePayloads(raw: string): unknown[] {
  return raw.split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice('data: '.length)))
}

test('media response emits thinking, media, success and terminal event', async () => {
  const response = createMediaGenerationResponse({
    requestSignal: new AbortController().signal,
    baseUrl: 'https://media.example/v1',
    apiKey: 'secret',
    authType: 'bearer',
    model: 'image-model',
    outputKind: 'image',
    prompt: 'a circle',
    thinking: '正在生成……',
    successText: '图片已生成。',
    generateMedia: async options => {
      assert.equal(options.signal?.aborted, false)
      assert.equal(options.prompt, 'a circle')
      return { type: 'image', url: 'data:image/png;base64,cG5n' }
    },
  })

  const raw = await response.text()
  assert.deepEqual(ssePayloads(raw), [
    { thinking: '正在生成……' },
    { media: { type: 'image', url: 'data:image/png;base64,cG5n' } },
    { text: '图片已生成。' },
  ])
  assert.match(raw, /data: \[DONE\]\n\n$/)
})

test('media response preserves platform permission guidance', async () => {
  const response = createMediaGenerationResponse({
    requestSignal: new AbortController().signal,
    baseUrl: 'https://media.example/v1',
    apiKey: 'secret',
    authType: 'bearer',
    model: 'image-model',
    outputKind: 'image',
    prompt: 'a circle',
    thinking: '正在生成……',
    successText: '图片已生成。',
    permissionError: '请为当前 Key 开启图片权限。',
    generateMedia: async () => {
      throw new MediaGenerationError('permission denied', 'permission_denied', 403)
    },
  })

  assert.deepEqual(ssePayloads(await response.text()), [
    { thinking: '正在生成……' },
    { error: '请为当前 Key 开启图片权限。' },
  ])
})

