import assert from "node:assert/strict"
import test from "node:test"

import { createJobEventStream } from "../lib/jobs/event-stream"
import type { PublicJobEvent } from "../lib/jobs/read-model"

const JOB_ID = "00000000-0000-4000-8000-000000000201"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000202"

function makeEvent(seq: number, kind: string, payload: PublicJobEvent["payload"]): PublicJobEvent {
  return {
    id: `event-${seq}`,
    jobId: JOB_ID,
    seq,
    kind,
    schemaVersion: 1,
    payload,
    createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
  }
}

test("Chat keeps a 2200-character reply flowing after a long upstream pause", async () => {
  const source = "真正的流式输出需要持续推进，不能停住几秒后再把几百字整块丢出来。".repeat(100).slice(0, 2200)
  const chunks = Array.from({ length: Math.ceil(source.length / 20) }, (_, index) => (
    source.slice(index * 20, (index + 1) * 20)
  ))
  const events: PublicJobEvent[] = chunks.map((chunk, index) => (
    makeEvent(index + 1, "text.delta", { text: chunk })
  ))
  events.push(makeEvent(events.length + 1, "job.terminal", { status: "completed" }))

  const availableAt = new Map<number, number>()
  for (let index = 0; index < chunks.length; index += 1) {
    availableAt.set(index + 1, index < 5 ? index * 40 : 1_500 + (index - 5) * 40)
  }
  availableAt.set(events.length, (availableAt.get(events.length - 1) ?? 0) + 40)

  let clock = 0
  const waits: number[] = []
  const deliveryLags: number[] = []
  const stream = createJobEventStream({
    client: {} as never,
    principalId: PRINCIPAL_ID,
    jobId: JOB_ID,
    fromSequence: 0,
    initialStatus: "running",
    requestSignal: new AbortController().signal,
    maxDurationMs: 30_000,
  }, {
    readEvents: async (_client, _principal, _job, after) => {
      const available = events
        .filter(event => event.seq > after && (availableAt.get(event.seq) ?? Infinity) <= clock)
        .slice(0, 4)
      for (const event of available) {
        if (event.kind === "text.delta") {
          deliveryLags.push(clock - (availableAt.get(event.seq) ?? clock))
        }
      }
      return { ok: true as const, value: available }
    },
    readJob: async () => ({
      ok: true as const,
      value: { status: clock >= (availableAt.get(events.length) ?? Infinity) ? "completed" : "running" } as never,
    }),
    wait: async milliseconds => {
      waits.push(milliseconds)
      clock += milliseconds
    },
    now: () => clock,
    initialPollIntervalMs: 35,
    maxPollIntervalMs: 80,
    statusRefreshIntervalMs: 2_000,
    heartbeatIntervalMs: 10_000,
    admissionRenewIntervalMs: 15_000,
    backpressureTimeoutMs: 5_000,
    backpressurePollMs: 25,
  })

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let raw = ""
  while (true) {
    const result = await reader.read()
    if (result.done) break
    raw += decoder.decode(result.value, { stream: true })
  }
  raw += decoder.decode()

  const deliveredChunks = [...raw.matchAll(/event: text\.delta\ndata: ([^\n]+)/g)]
    .map(match => JSON.parse(match[1]) as { payload: { text: string } })
    .map(event => event.payload.text)

  assert.equal(deliveredChunks.join(""), source)
  assert.equal(source.length, 2200)
  assert.ok(deliveredChunks.length > 100)
  assert.ok(Math.max(...deliveredChunks.map(chunk => chunk.length)) <= 20)
  assert.ok(Math.max(...waits) <= 80)
  assert.ok(Math.max(...deliveryLags) <= 80)
})
