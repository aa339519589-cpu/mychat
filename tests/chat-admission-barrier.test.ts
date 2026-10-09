import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { enqueueChatJob, type EnqueueChatJobInput } from '../lib/chat/job-command'
import { acceptedLiveChatResponse } from '../lib/chat/live-response'
import { receiveProcessLiveMessage } from '../lib/jobs/process-live-events'
import type { PublicJobSnapshot } from '../lib/jobs/read-model'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function input(): EnqueueChatJobInput {
  const userMessageId = randomUUID()
  return {
    body: { messages: [{ id: userMessageId, role: 'user', content: 'offline fixed-input test' }],
      conversationId: randomUUID(), userMessageId, assistantMessageId: randomUUID(), generationId: randomUUID(),
      healthContext: 'H'.repeat(127_996),
      turn: { schemaVersion: 1, createConversation: false, title: 'fixture', projectId: null } },
    userId: randomUUID(), isAnonymous: false, usingBalance: false, searchMode: 'off',
    outputKind: 'chat', requestId: randomUUID(), requestedAt: '2026-10-09T10:42:07.000Z',
  }
}
function snapshot(id: string): PublicJobSnapshot {
  const now = '2026-10-09T10:42:07.000Z'
  return { id, type: 'chat.generation', queue: 'chat', subject: {}, status: 'running',
    attempt: 1, maxAttempts: 3, priority: 0, availableAt: now, cancelRequestedAt: null,
    progress: {}, result: null, errorClass: null, errorCode: null, eventSequence: 0,
    createdAt: now, updatedAt: now, startedAt: now, terminalAt: null }
}

for (const delayedGuard of ['ownership', 'lease'] as const) {
  test(`same-input first-text replay preserves durable admission and the ${delayedGuard} guard`,
    { timeout: 2_000 }, async () => {
      const command = input(), jobId = command.body.generationId
      const receiptGate = deferred<void>(), enteredRpc = deferred<void>()
      const ownershipGate = deferred<void>(), leaseGate = deferred<void>()
      const order: string[] = []
      let rpcCalls = 0, wakes = 0, reads = 0, released = 0
      let settled = false
      const queued = enqueueChatJob(command, {
        createAdminClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
          assert.equal(name, 'admit_chat_turn_v3')
          assert.equal(JSON.stringify(args.input_payload).includes('H'.repeat(127_996)), true)
          rpcCalls += 1
          order.push('durable RPC entered')
          enteredRpc.resolve()
          await receiptGate.promise
          order.push('durable receipt delivered')
          return { data: { enqueued: true, replayed: false, job: { id: jobId, status: 'queued' } }, error: null }
        } } as never),
        publishWake: () => { wakes += 1; order.push('nonblocking worker wake') },
      }).then(value => { settled = true; return value })
      await enteredRpc.promise
      // A worker can observe an already-committed row before its RPC response is delivered.
      order.push('first model text published')
      receiveProcessLiveMessage({ type: 'mychat.job.live.v1', jobId, publishedAt: Date.now(),
        event: { kind: 'text.delta', payload: { text: '首字' }, offset: 0, revision: 1, streamId: randomUUID() } })
      await tick()
      assert.equal(settled, false, 'Buffered text cannot replace a successful durable receipt')
      assert.equal(wakes, 0)
      receiptGate.resolve()
      const accepted = await queued
      assert.equal(rpcCalls, 1, 'No speculative replay, duplicate enqueue or extra security read')
      assert.equal(wakes, 1)
      assert.equal(accepted.created, true)
      const abort = new AbortController()
      const channel = { on: () => channel, subscribe: () => channel }
      const client = {
        channel: () => channel,
        removeChannel: async () => {},
        from(table: string) {
          assert.equal(table, 'job_events')
          reads += 1
          const query: Record<string, unknown> = {}
          for (const method of ['select', 'eq', 'gt', 'order', 'limit', 'abortSignal']) query[method] = () => query
          query.then = (resolve: (value: unknown) => unknown) => new Promise<void>(done => {
            if (abort.signal.aborted) done()
            else abort.signal.addEventListener('abort', () => done(), { once: true })
          }).then(() => resolve({ data: [], error: null }))
          return query
        },
      }
      const response = acceptedLiveChatResponse({
        request: new Request('http://localhost/api/chat', { method: 'POST', signal: abort.signal }),
        client: client as never, principalId: command.userId, address: '127.0.0.1',
        accepted: { jobId, status: accepted.job.status, created: accepted.created,
          streamUrl: `/api/v1/jobs/${jobId}/live?from_seq=0` },
      }, {
        readJob: async () => { await ownershipGate.promise; order.push('ownership passed'); return { ok: true, value: snapshot(jobId) } },
        acquireStream: async () => {
          await leaseGate.promise
          order.push('lease passed')
          return { acquired: true, lease: { id: randomUUID(), hardExpiresAt: '2026-10-09T11:00:00Z',
            maxDurationMs: 60_000, renew: async () => true, release: async () => { released += 1 } } }
        },
      })
      const reader = response.body!.getReader()
      try {
        assert.equal(new TextDecoder().decode((await reader.read()).value), ': accepted\n\n')
        let textDelivered = false
        const text = reader.read().then(value => { textDelivered = true; return new TextDecoder().decode(value.value) })
        if (delayedGuard === 'ownership') leaseGate.resolve()
        else ownershipGate.resolve()
        await tick()
        assert.equal(textDelivered, false, `No first text may cross an unresolved ${delayedGuard} guard`)
        assert.equal(reads, 0, 'The actual live stream is not created until both guards pass')
        ownershipGate.resolve()
        leaseGate.resolve()
        assert.match(await text, /首字/)
        order.push('first text relayed')
        assert.equal(reads, 1, 'First text does not wait for the held durable event read')
        assert.ok(order.indexOf('first model text published') < order.indexOf('durable receipt delivered'))
        assert.ok(order.indexOf('first text relayed') > order.indexOf('ownership passed'))
        assert.ok(order.indexOf('first text relayed') > order.indexOf('lease passed'))
      } finally {
        abort.abort()
        await reader.cancel()
        await tick()
      }
      assert.equal(released, 1)
    })
}
