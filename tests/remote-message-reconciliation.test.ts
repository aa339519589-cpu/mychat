import assert from "node:assert/strict"
import test from "node:test"

import type { Message } from "../lib/chat-data"
import { reconcileRemoteMessages } from "../lib/data/remote-message-reconciliation"

const message = (value: Partial<Message> & Pick<Message, "id" | "role" | "content">): Message => ({
  time: "",
  ...value,
})

test("fresh history keeps a newer optimistic turn after the last shared row", () => {
  const existing = [
    message({ id: "old", role: "assistant", content: "old", ts: "2026-07-18T10:00:00.000Z" }),
    message({ id: "user-new", role: "user", content: "new question", ts: "2026-07-18T10:01:00.000Z" }),
    message({ id: "assistant-new", role: "assistant", content: "partial answer" }),
  ]
  const incoming = [
    message({ id: "old", role: "assistant", content: "old", ts: "2026-07-18T10:00:00.000Z" }),
  ]

  const merged = reconcileRemoteMessages(existing, incoming)
  assert.deepEqual(merged.map(item => item.id), ["old", "user-new", "assistant-new"])
  assert.equal(merged.at(-1)?.content, "partial answer")
})

test("an empty lagging read cannot erase a locally started first turn", () => {
  const existing = [
    message({ id: "user-new", role: "user", content: "new question", ts: "2026-07-18T10:01:00.000Z" }),
    message({ id: "assistant-new", role: "assistant", content: "partial answer" }),
  ]

  assert.deepEqual(reconcileRemoteMessages(existing, []).map(item => item.id), ["user-new", "assistant-new"])
})

test("an empty authoritative read clears ordinary old cached history", () => {
  const existing = [
    message({ id: "old-user", role: "user", content: "old", ts: "2026-07-18T09:00:00.000Z" }),
    message({
      id: "old-assistant",
      role: "assistant",
      content: "done",
      generation: { id: "g-old", status: "completed", sequence: 4, error: null },
    }),
  ]

  assert.deepEqual(reconcileRemoteMessages(existing, []), [])
})

test("a remote placeholder cannot erase a locally streamed assistant prefix", () => {
  const existing = [
    message({ id: "assistant", role: "assistant", content: "streamed prefix", thinking: "working" }),
  ]
  const incoming = [message({ id: "assistant", role: "assistant", content: "" })]

  const [merged] = reconcileRemoteMessages(existing, incoming)
  assert.equal(merged.content, "streamed prefix")
  assert.equal(merged.thinking, "working")
})

test("a remote terminal remains authoritative over a local prefix", () => {
  const existing = [message({ id: "assistant", role: "assistant", content: "partial" })]
  const incoming = [message({
    id: "assistant",
    role: "assistant",
    content: "complete",
    generation: { id: "g1", status: "completed", sequence: 9, error: null },
  })]

  const [merged] = reconcileRemoteMessages(existing, incoming)
  assert.equal(merged.content, "complete")
  assert.equal(merged.generation?.sequence, 9)
})
