import assert from 'node:assert/strict'
import test from 'node:test'

import { makeContentFilter } from '../lib/llm/content-filter'
import { TurnAccumulator } from '../lib/llm/turn-accumulator'

test('Chat forwards the first normal text token immediately', () => {
  const emitted: object[] = []
  const accumulator = new TurnAccumulator({
    generic: false,
    model: 'chat-stream-test',
    emit: event => emitted.push(event),
    timingEnabled: false,
    startedAt: 0,
  })

  accumulator.handle({ choices: [{ delta: { content: '首' } }] })
  accumulator.handle({ choices: [{ delta: { content: '字' } }] })

  assert.deepEqual(emitted, [{ text: '首' }, { text: '字' }])
})

test('low-latency filtering still hides split tool protocol markers', () => {
  const filter = makeContentFilter()

  assert.equal(filter.feed('正常正文<｜tool'), '正常正文')
  assert.equal(filter.feed('▁calls▁begin｜>{"secret":true}'), '')
  assert.equal(filter.feed('<｜tool▁calls▁end｜>继续'), '继续')
  assert.equal(filter.flush(), '')
})

test('bounded lookbehind remains available for explicit opt-out', () => {
  const filter = makeContentFilter({ lowLatency: false })

  assert.equal(filter.feed('短回复'), '')
  assert.equal(filter.flush(), '短回复')
})

test('explicit provider summaries stream immediately without relabelling raw reasoning', () => {
  const emitted: object[] = []
  const accumulator = new TurnAccumulator({ generic: false, model: 'summary-test',
    emit: event => emitted.push(event), timingEnabled: false, startedAt: 0 })
  accumulator.handle({ type: 'response.reasoning_summary_text.delta', delta: '核对资料' })
  assert.deepEqual(emitted, [{ reasoningSummary: '核对资料' }])
  accumulator.handle({ choices: [{ delta: { reasoning_content: 'private', reasoning_summary: '读取文件' } }] })
  accumulator.handle({ choices: [{ delta: { content: '首' } }] })
  assert.deepEqual(emitted, [{ reasoningSummary: '核对资料' }, { thinking: 'private' },
    { reasoningSummary: '读取文件' }, { text: '首' }])
})
