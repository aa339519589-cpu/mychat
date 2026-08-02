import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceVisibleText } from '../components/literary-chat/chat-stream-state'
import { JobEventWriter } from '../lib/jobs/event-writer'
import type { JobEventDraft } from '../lib/jobs/contracts'
import type { JobExecutionContext } from '../lib/jobs/worker'

function writerHarness(appendDelayMs = 2) {
  const batches: JobEventDraft[][] = []
  const context = {
    job: { id: 'stream-test', type: 'chat.generation', checkpoint: null },
    fence: { jobId: 'stream-test', workerId: 'worker', leaseVersion: 1 },
    signal: new AbortController().signal,
    assertAuthority() {},
    async appendEvents(events: readonly JobEventDraft[]) {
      await new Promise(resolve => setTimeout(resolve, appendDelayMs))
      batches.push([...events])
    },
    async checkpoint() {},
  } as unknown as JobExecutionContext
  return { context, batches }
}

function takeCharacters(value: string, start: number, count: number): string {
  return Array.from(value).slice(start, start + count).join('')
}

test('Chat carries a 2400+ character answer without giant durable or visible bursts', async () => {
  const paragraph = '真正顺滑的流式输出应当尽快展示首个字符，并持续稳定地向前推进，不能停顿数秒后突然抛出整段内容。'
  const source = paragraph.repeat(56)
  const sourceLength = Array.from(source).length
  assert.ok(sourceLength > 2_400)

  const burstPattern = [10, 420, 7, 690, 3, 512, 31, 880]
  const harness = writerHarness()
  const writer = new JobEventWriter(harness.context)
  let offset = 0
  let patternIndex = 0
  while (offset < sourceLength) {
    const requested = burstPattern[patternIndex % burstPattern.length] ?? 1
    const chunk = takeCharacters(source, offset, requested)
    writer.emit({ text: chunk })
    offset += Array.from(chunk).length
    patternIndex += 1
  }
  await writer.drain()

  const textEvents = harness.batches
    .flat()
    .filter(event => event.kind === 'text.delta')
  const durableText = textEvents
    .map(event => typeof event.payload.text === 'string' ? event.payload.text : '')
    .join('')
  const durableSizes = textEvents.map(event => Array.from(String(event.payload.text ?? '')).length)

  assert.equal(durableText, source)
  assert.ok(textEvents.length > 100)
  assert.ok(Math.max(...durableSizes) <= 24)
  assert.ok(harness.batches.every(batch => batch.length <= 12))

  let target = ''
  let visible = ''
  const visibleSteps: number[] = []
  for (const batch of harness.batches) {
    target += batch
      .filter(event => event.kind === 'text.delta')
      .map(event => String(event.payload.text ?? ''))
      .join('')
    while (visible !== target) {
      const next = advanceVisibleText(visible, target, false)
      visibleSteps.push(Array.from(next.slice(visible.length)).length)
      visible = next
    }
  }

  assert.equal(visible, source)
  assert.equal(visibleSteps[0], 1)
  assert.ok(Math.max(...visibleSteps) <= 24)
  assert.ok(visibleSteps.length > 100)

  console.info('[chat-stream-2400]', {
    characters: sourceLength,
    durableEvents: textEvents.length,
    durableBatches: harness.batches.length,
    maximumDurableChunk: Math.max(...durableSizes),
    visibleFrames: visibleSteps.length,
    maximumVisibleStep: Math.max(...visibleSteps),
  })
})
