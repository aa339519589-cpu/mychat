import assert from "node:assert/strict"
import test from "node:test"
import { parseSseEvent, splitSseEvents } from "../components/literary-chat/stream-events"
import { isGenerationTerminalSnapshot } from "../lib/generation/types"

test("splitSseEvents preserves an incomplete event between chunks", () => {
  const first = splitSseEvents('data: {"text":"a"}\n\ndata: {"text"')
  assert.deepEqual(first.events, ['data: {"text":"a"}'])
  assert.equal(first.rest, 'data: {"text"')

  const second = splitSseEvents(`${first.rest}:"b"}\n\n`)
  assert.deepEqual(second.events, ['data: {"text":"b"}'])
  assert.equal(second.rest, "")
})

test("splitSseEvents accepts CRLF event framing", () => {
  const result = splitSseEvents('data: {"thinking":"x"}\r\n\r\n')
  assert.deepEqual(result.events, ['data: {"thinking":"x"}'])
})

test("parseSseEvent parses JSON data and the done sentinel", () => {
  assert.deepEqual(parseSseEvent('data: {"text":"hello"}'), {
    kind: "data",
    data: { text: "hello" },
  })
  assert.deepEqual(parseSseEvent("data: [DONE]"), { kind: "done" })
  assert.equal(parseSseEvent("event: ping"), null)
  assert.equal(parseSseEvent("data: not-json"), null)
})

test("parseSseEvent joins multi-line data fields", () => {
  assert.deepEqual(parseSseEvent('data: {"value":\ndata: 1}'), {
    kind: "data",
    data: { value: 1 },
  })
})

test("terminal snapshots require the complete canonical payload", () => {
  assert.equal(isGenerationTerminalSnapshot({
    status: "cancelled",
    content: "database-prefix",
    thinking: "database-thinking",
    sequence: 12,
    error: null,
    media: [],
  }), true)
  assert.equal(isGenerationTerminalSnapshot({
    status: "cancelled",
    content: "database-prefix",
    thinking: "database-thinking",
    sequence: 12,
    media: [],
  }), false)
  assert.equal(isGenerationTerminalSnapshot({
    status: "running",
    content: "",
    thinking: "",
    sequence: 1,
    error: null,
    media: [],
  }), false)
  assert.equal(isGenerationTerminalSnapshot({
    status: "completed",
    content: "done",
    thinking: "",
    sequence: 2,
    error: null,
    media: [{ type: "image", url: "data:image/png;base64,AQ==", mimeType: "image/png" }],
  }), false)
  assert.equal(isGenerationTerminalSnapshot({
    status: "completed",
    content: "done",
    thinking: "",
    sequence: 2,
    error: null,
    media: [{
      type: "image",
      url: "https://project.supabase.co/storage/v1/object/public/generated-media/u/c/g/a.png",
      mimeType: "image/png",
    }],
  }), true)
})
