import assert from 'node:assert/strict'
import test from 'node:test'
import { privateChatResponse, privateUsageIdentity } from '../lib/chat/private-stream'
import { customModelCapability } from '../lib/llm/models'
import type { ChatModelSelection } from '../lib/chat/model-selection'
import type { JobRepository } from '../lib/jobs/repository'
import type { runAgentLoop } from '../lib/llm/agent-loop'

const selection: ChatModelSelection = { customEndpoint: false, model: 'audit/model', thinking: false,
  reasoningEffort: null, accessClass: 'quota', capability: customModelCapability('audit/model', 'https://model.example'),
  apiKey: 'test-key', outputKind: 'chat' }
const lease = { jobId: 'a3911000-0000-4000-8000-000000000001', workerId: 'private-worker', leaseVersion: 1, attempt: 1 }
type Finalize = Parameters<JobRepository['finalize']>[0]
type Loop = Parameters<typeof runAgentLoop>[0]

function fixture(runLoop: typeof runAgentLoop, overrides: Partial<Parameters<typeof privateChatResponse>[0]> = {}) {
  const finalized: Finalize[] = []
  const repository: Pick<JobRepository, 'renew' | 'finalize'> = {
    renew: async () => ({ state: 'renewed', status: 'leased', leaseExpiresAt: new Date(Date.now() + 30_000).toISOString(), cancelRequested: false }),
    finalize: async input => {
      finalized.push(input)
      return { accepted: true, replayed: false, status: input.status, result: input.result ?? null, error: input.error ?? null, eventSeq: 3 }
    },
  }
  const response = privateChatResponse({ request: new Request('https://mychat.example/api/chat/private'),
    body: { conversationId: 'client-ephemeral-id', messages: [{ role: 'user', content: 'private prompt marker' }] },
    selection, lease, usingBalance: false, tokenLimit: 160_000, ...overrides }, { repository, runLoop, renewMs: 5 })
  return { response, finalized }
}

function events(raw: string): Array<{ kind: string; payload: Record<string, unknown>; jobId: string }> {
  return raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
}

test('private stream emits real content but only metadata and usage reach settlement', async () => {
  const value = fixture(async options => {
    assert.ok(options.messages.some(message => message.content === 'private prompt marker'))
    assert.deepEqual(options.tools, [])
    options.emit({ thinking: 'private thought marker' })
    options.emit({ text: 'private answer marker' })
    await options.onUsage?.(17)
    await options.onCheckpoint?.(options.messages)
    return { totalTokens: 17, tokenUsage: { inputTokens: 10, outputTokens: 7 } }
  })
  const parsed = events(await value.response.text())
  assert.equal(value.response.headers.get('Cache-Control'), 'no-store')
  assert.equal(value.response.headers.get('X-Private-Usage-Job'), lease.jobId)
  assert.ok(parsed.every(event => event.jobId === 'client-ephemeral-id'))
  assert.deepEqual(parsed.map(event => event.kind), ['thinking.delta', 'text.delta', 'model.output_completed', 'job.terminal'])
  assert.equal(parsed.at(-1)?.payload.status, 'completed')
  assert.equal(value.finalized.length, 1)
  assert.deepEqual(value.finalized[0].result, { schemaVersion: 1, totalTokens: 17 })
  assert.equal(value.finalized[0].ledgerEntries?.[0].rawTokens, 17)
  assert.equal(value.finalized[0].ledgerEntries?.[0].metadata?.private, true)
  assert.doesNotMatch(JSON.stringify(value.finalized), /private (prompt|thought|answer) marker/)
})

test('private provider failures are terminal, release admission, and do not expose provider secrets', async () => {
  const value = fixture(async () => { throw new Error('upstream test-key private prompt marker') })
  const raw = await value.response.text()
  assert.equal(events(raw).at(-1)?.payload.status, 'failed')
  assert.equal(value.finalized[0].status, 'failed')
  assert.deepEqual(value.finalized[0].ledgerEntries, [])
  assert.doesNotMatch(raw + JSON.stringify(value.finalized), /test-key|private prompt marker/)
})

test('private stream cancellation aborts the provider and settles only consumed usage once', async () => {
  let start!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  let done!: () => void
  const completed = new Promise<void>(resolve => { done = resolve })
  const value = fixture(async options => {
    options.emit({ text: 'partial private answer' })
    await options.onUsage?.(5)
    start()
    await new Promise<void>((_resolve, reject) => options.turnOptions!.signal!.addEventListener('abort', () => {
      done(); reject(new Error('cancelled'))
    }, { once: true }))
    return { totalTokens: 5 }
  })
  await started
  await value.response.body!.cancel()
  await completed
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(value.finalized.length, 1)
  assert.equal(value.finalized[0].status, 'cancelled')
  assert.equal(value.finalized[0].ledgerEntries?.[0].rawTokens, 5)
  assert.doesNotMatch(JSON.stringify(value.finalized), /partial private answer/)
})

test('private budget stops oversized context before contacting a provider', async () => {
  let calls = 0
  const value = fixture(async () => { calls++; return { totalTokens: 0 } }, {
    tokenLimit: 30_000,
    body: { conversationId: 'ephemeral', messages: [{ role: 'user', content: 'x'.repeat(30_000) }] },
  })
  assert.equal(events(await value.response.text()).at(-1)?.payload.status, 'failed')
  assert.equal(calls, 0)
})

test('private request identities never reuse a durable job or lease', () => {
  const first = privateUsageIdentity(), second = privateUsageIdentity()
  assert.notEqual(first.jobId, second.jobId)
  assert.notEqual(first.workerId, second.workerId)
})

test('private lease loss aborts active generation and never reports completion', async () => {
  const finalized: Finalize[] = []
  const response = privateChatResponse({ request: new Request('https://mychat.example'),
    body: { conversationId: 'ephemeral', messages: [] }, selection, lease, usingBalance: false, tokenLimit: 160_000 }, {
    renewMs: 1,
    repository: {
      renew: async () => ({ state: 'lost', status: 'failed', leaseExpiresAt: null, cancelRequested: false }),
      finalize: async input => { finalized.push(input); throw new Error('stale fence') },
    },
    runLoop: async (options: Loop) => {
      await new Promise<void>((_resolve, reject) => options.turnOptions!.signal!.addEventListener('abort', () => reject(new Error('lease lost')), { once: true }))
      return { totalTokens: 0 }
    },
  })
  const raw = await response.text()
  assert.doesNotMatch(raw, /model.output_completed|"status":"completed"/)
  assert.equal(finalized.length, 1)
  assert.equal(finalized[0].status, 'cancelled')
})
