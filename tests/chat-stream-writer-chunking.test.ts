import assert from "node:assert/strict"
import test from "node:test"

import { JobEventWriter } from "../lib/jobs/event-writer"

test("Chat writer keeps a 2200-character reply in bounded durable deltas", async () => {
  const appended: Array<{ kind: string; payload: Record<string, unknown> }> = []
  const writer = new JobEventWriter({
    job: { checkpoint: null },
    assertAuthority: () => {},
    appendEvents: async events => {
      appended.push(...events.map(event => ({
        kind: event.kind,
        payload: event.payload as Record<string, unknown>,
      })))
    },
  } as never)

  const source = "真正的流式输出应当持续前进，不能卡住数秒后一次蹦出几百字。".repeat(100).slice(0, 2200)
  for (let offset = 0; offset < source.length; offset += 7) {
    writer.emit({ text: source.slice(offset, offset + 7) })
  }
  await writer.drain()

  const textEvents = appended.filter(event => event.kind === "text.delta")
  const chunks = textEvents.map(event => String(event.payload.text ?? ""))
  assert.equal(chunks.join(""), source)
  assert.ok(chunks.length > 30)
  assert.ok(Math.max(...chunks.map(chunk => chunk.length)) <= 64)
})
