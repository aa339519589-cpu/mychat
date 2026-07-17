import assert from 'node:assert/strict'
import test from 'node:test'
import { parseChatProbeContent } from '../lib/llm/openai-compatible/probe'

test('chat probe parser accepts JSON text and structured content parts', () => {
  assert.equal(parseChatProbeContent(JSON.stringify({
    choices: [{ message: { content: 'OK' } }],
  }), 'application/json; charset=utf-8'), 'OK')

  assert.equal(parseChatProbeContent(JSON.stringify({
    choices: [{ message: { content: [
      { type: 'text', text: 'O' },
      { type: 'output_text', text: 'K' },
    ] } }],
  }), 'application/json'), 'OK')
})

test('chat probe parser combines valid SSE chunks and ignores malformed object content', () => {
  const raw = [
    'event: message',
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'O' } }] })}`,
    'data: not-json',
    `data: ${JSON.stringify({ choices: [{ delta: { content: { text: 'unsafe' } } }] })}`,
    `data: ${JSON.stringify({ choices: [{ text: 'K' }] })}`,
    'data: [DONE]',
  ].join('\n')

  const content = parseChatProbeContent(raw, 'text/event-stream')
  assert.equal(content, 'OK')
  assert.doesNotMatch(content, /\[object Object\]|unsafe/)
})
