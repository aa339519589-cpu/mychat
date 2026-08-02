import assert from "node:assert/strict"
import test from "node:test"

import { createJobEventStream, nextActivePollInterval } from "../lib/jobs/event-stream"
import type { PublicJobEvent } from "../lib/jobs/read-model"

const JOB_ID = "00000000-0000-4000-8000-000000000001"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000002"

function textEvent(seq: number, text: string): PublicJobEvent {
  return {
    id: `event-${seq}`,
    seq,
    kind: "text.delta",
    schemaVersion: 1,
    jobId: JOB_ID,
    payload: { text },
    createdAt: new Date(1_700_000_000_000 + seq).toISOString(),
  }
}

test("active job polling never backs off into multi-second Chat stalls", () => {
  let interval = 35
  const observed: number[] = []
  for (let index = 0; index < 100; index += 1) {
    interval = nextActivePollInterval(interval, false)
    observed.push(interval)
  }
  assert.equal(Math.max(...observed), 80)
  assert.equal(nextActivePollInterval(80, true), 35)
})

test("Chat streams a 2200-character reply through many bounded events", async () => {
  const source = "流式输出应持续前进，不能停住几秒再突然整段出现。".repeat(100).slice(0, 2200)
  const chunks = Array.from({ length: Math.ceil(source.length / 40) }, (_, index) => source.slice(index * 40, (index + 1) * 40))
  const events: PublicJobEvent[] = chunks.map((chunk, index) => textEvent(index + 1, chunk))
  events.push({
    id: `event-${events.length + 1}`,
    seq: events.length + 1,
    kind: "job.terminal",
    schemaVersion: 1,
    jobId: JOB_ID,
    payload: { status: "completed" },
    createdAt: new Date(1_700_000_100_000).toISOString(),
  })

  let cursor = 0
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
    readEvents: async (_client, _principal, _job, after) => {
      const available = events.filter(event => event.seq > after).slice(0, 3)
      cursor += available.length
      return { ok: true as const, value: available }
    },
    readJob: async () => ({ ok: true as const, value: { status: cursor >= events.length ? "completed" : "running" } as never }),
    wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds },
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
