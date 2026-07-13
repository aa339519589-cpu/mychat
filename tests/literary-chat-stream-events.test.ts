import assert from "node:assert/strict"
import test from "node:test"
import { parseSseEvent, splitSseEvents } from "../components/literary-chat/stream-events"

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
