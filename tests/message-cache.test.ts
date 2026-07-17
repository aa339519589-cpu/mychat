import assert from "node:assert/strict"
import test from "node:test"

import {
  mergeCachedMessageSnapshots,
  mergeCachedMessages,
  normalizeCachedMessages,
  readCachedMessages,
  writeCachedMessages,
} from "../lib/data/message-cache"
import { upsertGenerationTerminalMessage } from "../lib/data/generation-cache"

test("message cache normalization rejects malformed entries and preserves safe fields", () => {
  const messages = normalizeCachedMessages([
    null,
    { id: "bad-role", role: "system", content: "hidden" },
    {
      id: "m1",
      role: "assistant",
      content: "hello",
      time: "10:00",
      images: ["https://example.com/image.png", 42],
      memoryNotes: ["remember", false],
      searchNotes: [
        { query: "safe", results: [{ title: "Docs", url: "https://example.com/docs" }] },
        { query: "unsafe", results: [{ title: "Run", url: "javascript:alert(1)" }] },
        { query: 42, results: [] },
      ],
    },
  ])

  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, "m1")
  assert.equal(messages[0].role, "assistant")
  assert.equal(messages[0].content, "hello")
  assert.deepEqual(messages[0].images, ["https://example.com/image.png"])
  assert.deepEqual(messages[0].memoryNotes, ["remember"])
  assert.deepEqual(messages[0].searchNotes, [
    { query: "safe", results: [{ title: "Docs", url: "https://example.com/docs" }] },
    { query: "unsafe", results: [] },
  ])
})

test("message cache preserves terminal metadata and derives cancelled state", () => {
  const [message] = normalizeCachedMessages([{
    id: "m-terminal",
    role: "assistant",
    content: "partial",
    generation: {
      id: "g-terminal",
      status: "cancelled",
      sequence: 9,
      error: null,
    },
  }])

  assert.equal(message.generation?.id, "g-terminal")
  assert.equal(message.generation?.sequence, 9)
  assert.equal(message.outputWarning, "已停止生成")
})

test("a stale hydrate cannot overwrite a newer terminal cache", () => {
  const terminal = normalizeCachedMessages([{
    id: "m1",
    role: "assistant",
    content: "canonical",
    generation: { id: "g1", status: "completed", sequence: 12, error: null },
  }])
  const stale = normalizeCachedMessages([{
    id: "m1",
    role: "assistant",
    content: "partial",
  }])

  const [merged] = mergeCachedMessages(terminal, stale)
  assert.equal(merged.content, "canonical")
  assert.equal(merged.generation?.sequence, 12)
})

test("new local terminal wins over old IndexedDB after an interrupted async commit", () => {
  const indexed = normalizeCachedMessages([{
    id: "m1",
    role: "assistant",
    content: "old-db-prefix",
  }])
  const local = normalizeCachedMessages([{
    id: "m1",
    role: "assistant",
    content: "new-local-terminal",
    generation: { id: "g1", status: "failed", sequence: 21, error: "provider_failed" },
  }])

  const [merged] = mergeCachedMessageSnapshots(
    { messages: indexed, ts: 100 },
    { messages: local, ts: 200 },
  )
  assert.equal(merged.content, "new-local-terminal")
  assert.equal(merged.generation?.sequence, 21)
  assert.equal(merged.isError, true)
})

test("generation sequence beats backend timestamp when cache commits arrive out of order", () => {
  const terminal = normalizeCachedMessages([{
    id: "m1",
    role: "assistant",
    content: "sequence-30",
    generation: { id: "g1", status: "completed", sequence: 30, error: null },
  }])
  const stale = normalizeCachedMessages([{
    id: "m1",
    role: "assistant",
    content: "sequence-20",
    generation: { id: "g1", status: "completed", sequence: 20, error: null },
  }])

  const [merged] = mergeCachedMessageSnapshots(
    { messages: terminal, ts: 100 },
    { messages: stale, ts: 300 },
  )
  assert.equal(merged.content, "sequence-30")
  assert.equal(merged.generation?.sequence, 30)
})

test("cross-store merge retains older-only messages when localStorage is truncated", () => {
  const indexed = normalizeCachedMessages(Array.from({ length: 3 }, (_, index) => ({
    id: `m${index + 1}`,
    role: index % 2 ? "assistant" : "user",
    content: `message-${index + 1}`,
  })))
  const local = indexed.slice(-1)
  const merged = mergeCachedMessageSnapshots(
    { messages: indexed, ts: 100 },
    { messages: local, ts: 100 },
  )
  assert.deepEqual(merged.map(message => message.id), ["m1", "m2", "m3"])
})

test("legacy IDB full history keeps chronological order when its timestamp is newer", () => {
  const indexed = normalizeCachedMessages(Array.from({ length: 5 }, (_, index) => ({
    id: `m${index + 1}`,
    role: "assistant",
    content: `${index + 1}`,
  })))
  const local = indexed.slice(-2)
  const merged = mergeCachedMessageSnapshots(
    { messages: indexed, ts: 200 },
    { messages: local, ts: 100 },
  )
  assert.deepEqual(merged.map(message => message.id), ["m1", "m2", "m3", "m4", "m5"])
})

test("same commit uses full IDB order while preserving a local terminal sequence", () => {
  const indexed = normalizeCachedMessages(Array.from({ length: 5 }, (_, index) => ({
    id: `m${index + 1}`,
    role: "assistant",
    content: `${index + 1}`,
  })))
  const local = normalizeCachedMessages([{
    id: "m4", role: "assistant", content: "4",
  }, {
    id: "m5", role: "assistant", content: "canonical",
    generation: { id: "g5", status: "completed", sequence: 9, error: null },
  }])
  const merged = mergeCachedMessageSnapshots(
    { messages: indexed, ts: 300, commitId: "same", totalCount: 5, truncated: false },
    { messages: local, ts: 300, commitId: "same", totalCount: 5, truncated: true },
  )
  assert.deepEqual(merged.map(message => message.id), ["m1", "m2", "m3", "m4", "m5"])
  assert.equal(merged.at(-1)?.content, "canonical")
})

test("a newer complete commit treats missing IDs as intentional deletion", () => {
  const old = normalizeCachedMessages([
    { id: "m1", role: "user", content: "keep" },
    { id: "m2", role: "assistant", content: "deleted branch" },
  ])
  const current = normalizeCachedMessages([{ id: "m1", role: "user", content: "keep" }])
  const merged = mergeCachedMessageSnapshots(
    { messages: old, ts: 100, commitId: "old", totalCount: 2, truncated: false },
    { messages: current, ts: 200, commitId: "new", totalCount: 1, truncated: false },
  )
  assert.deepEqual(merged.map(message => message.id), ["m1"])
})

test("a newer complete empty commit clears an older snapshot from either cache store", () => {
  const old = normalizeCachedMessages([
    { id: "m1", role: "user", content: "stale local history" },
    {
      id: "m2",
      role: "assistant",
      content: "stale terminal",
      generation: { id: "g2", status: "completed", sequence: 7, error: null },
    },
  ])
  const empty = { messages: [], ts: 200, commitId: "empty", totalCount: 0, truncated: false }

  assert.deepEqual(mergeCachedMessageSnapshots(
    { messages: old, ts: 100, commitId: "old", totalCount: 2, truncated: false },
    empty,
  ), [])
  assert.deepEqual(mergeCachedMessageSnapshots(
    empty,
    { messages: old, ts: 100, commitId: "old", totalCount: 2, truncated: true },
  ), [])
})

test("an older empty commit cannot erase a newer truncated terminal snapshot", () => {
  const terminal = normalizeCachedMessages([{
    id: "m2",
    role: "assistant",
    content: "canonical terminal",
    generation: { id: "g2", status: "completed", sequence: 8, error: null },
  }])
  const merged = mergeCachedMessageSnapshots(
    { messages: [], ts: 100, commitId: "old-empty", totalCount: 0, truncated: false },
    { messages: terminal, ts: 200, commitId: "new-terminal", totalCount: 4, truncated: true },
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].content, "canonical terminal")
  assert.equal(merged[0].generation?.sequence, 8)
})

test("writing an authoritative empty snapshot replaces localStorage history", async t => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const values = new Map<string, string>()
  const fakeWindow = {
    indexedDB: undefined,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    },
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow })
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
  })

  await writeCachedMessages("empty-authority", normalizeCachedMessages([
    { id: "m1", role: "assistant", content: "stale" },
  ]))
  await writeCachedMessages("empty-authority", [])

  assert.deepEqual(await readCachedMessages("empty-authority"), [])
  const payload = JSON.parse(values.get("mychat_messages_empty-authority") ?? "null")
  assert.equal(payload.totalCount, 0)
  assert.equal(payload.truncated, false)
  assert.deepEqual(payload.messages, [])
})

test("latest terminal is cached even when stale history omitted its assistant", () => {
  const messages = upsertGenerationTerminalMessage([], "assistant-latest", {
    status: "completed",
    content: "canonical latest",
    thinking: "done",
    media: [],
    sequence: 11,
    error: null,
    generationId: "generation-latest",
  })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, "assistant-latest")
  assert.equal(messages[0].content, "canonical latest")
  assert.equal(messages[0].generation?.sequence, 11)
})
