import assert from "node:assert/strict"
import test from "node:test"

import { createJobEventStream } from "../lib/jobs/event-stream"
import { JobEventWriter } from "../lib/jobs/event-writer"
import type { PublicJobEvent } from "../lib/jobs/read-model"

const JOB_ID = "00000000-0000-4000-8000-000000000101"
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000102"

test("a 2200-character Chat reply stays incremental through writer and SSE reader", async () => {
  const persisted: PublicJobEvent[] = []
  let sequence = 0
  const writer = new JobEventWriter({
    job: { checkpoint: null },
    assertAuthority: () => {},
    appendEvents: async drafts => {
      for (const draft of drafts) {
        sequence += 1
        persisted.push({
          id: `event-${sequence}`,
          jobId: JOB_ID,
          seq: sequence,
          kind: draft.kind,
          schemaVersion: 1,
          payload: draft.payload,
          createdAt: new Date(1_700_000_000_000 + sequence).toISOString(),
        })
      }
    },
  } as never)

  const source = "这是一段用于验证真实流式输出的长文本，必须持续出现，不能停顿几秒后整块蹦出。".repeat(100).slice(0, 2200)
  for (let offset = 0; offset < source.length; offset += 9) {
    writer.emit({ text: source.slice(offset, offset + 9) })
  }
  await writer.drain()
  sequence += 1
  persisted.push({
    id: `event-${sequence}`,
    jobId: JOB_ID,
    seq: sequence,
    kind: "job.terminal",
    schemaVersion: 1,
    payload: { status: "completed" },
    createdAt: new Date(1_700_000_100_000).toISOString(),
  })

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
      value: persisted.filter(event => event.seq > after).slice(0, 4),
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

  const chunks = [...raw.matchAll(/event: text\.delta\ndata: ([^\n]+)/g)]
    .map(match => JSON.parse(match[1]) as { payload: { text: string } })
    .map(event => event.payload.text)

  assert.equal(chunks.join(""), source)
  assert.equal(source.length, 2200)
  assert.ok(chunks.length > 30)
  assert.ok(Math.max(...chunks.map(chunk => chunk.length)) <= 64)
  assert.ok(Math.max(...waits) <= 80)
})
