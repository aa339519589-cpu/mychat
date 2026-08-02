import assert from "node:assert/strict"
import test from "node:test"

import { createJobEventStream } from "../lib/jobs/event-stream"
import type { PublicJobEvent } from "../lib/jobs/read-model"

const JOB_ID = "00000000-0000-4000-8000-000000000001"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000002"

function jobEvent(seq: number, kind: string, payload: Record<string, string>): PublicJobEvent {
  return {
    id: `event-${seq}`,
    seq,
    kind,
    schemaVersion: 1,
    jobId: JOB_ID,
    payload,
    createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
  }
}

test("Chat delivers a 2200-character response without multi-second polling gaps", async () => {
  const source = "流式输出必须持续前进，不能停住几秒再突然整段出现。".repeat(100).slice(0, 2200)
  const chunks = Array.from({ length: Math.ceil(source.length / 40) }, (_, index) => (
    source.slice(index * 40, (index + 1) * 40)
  ))
  const events: PublicJobEvent[] = chunks.map((chunk, index) => (
    jobEvent(index + 1, "text.delta", { text: chunk })
  ))
  events.push(jobEvent(events.length + 1, "job.terminal", { status: "completed" }))

  let clock = 0
  const waits: number[] = []
  const stream = createJobEventStream({
    client: {} as never,
    principalId: PRINCIPAL_ID,
    jobId: JOB_ID,
    fromSequence: 0,
    initialStatus: "running",
    requestSignal: new AbortController().signal,
    maxDurationMs: 10_000,
  }, {
    readEvents: async (_client, _principal, _job, after) => ({
      ok: true as const,
      value: events.filter(event => event.seq > after).slice(0, 3),
    }),
    readJob: async () => ({ ok: true as const, value: { status: "completed" } as never }),
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

  const delivered = [...raw.matchAll(/event: text\.delta\ndata: ([^\n]+)/g)]
    .map(match => JSON.parse(match[1]) as { payload: { text: string } })
    .map(event => event.payload.text)
    .join("")

  assert.equal(delivered, source)
  assert.equal(delivered.length, 2200)
  assert.ok(chunks.length > 50)
  assert.ok(waits.length > 10)
  assert.ok(Math.max(...waits) <= 80)
})
