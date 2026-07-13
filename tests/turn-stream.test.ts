import assert from "node:assert/strict"
import test from "node:test"
import { GenericResponseLimitError, MAX_GENERIC_SUCCESS_RESPONSE_BYTES } from "../lib/llm/turn-response"
import { CallerOutputLimitReached, consumeTurnResponse } from "../lib/llm/turn-stream"

test("turn response consumer handles JSON and caller-owned output limits", async () => {
  const values: unknown[] = []
  const consumed = await consumeTurnResponse(Response.json({ value: 1 }), false, value => values.push(value))
  assert.deepEqual(values, [{ value: 1 }])
  assert.deepEqual(consumed, { sawDone: false, callerLimitReached: false })

  const limited = await consumeTurnResponse(Response.json({ value: 2 }), false, () => {
    throw new CallerOutputLimitReached()
  })
  assert.deepEqual(limited, { sawDone: true, callerLimitReached: true })
})

test("turn response consumer skips malformed SSE and preserves final events", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = new TextEncoder()
      controller.enqueue(encode.encode("not-json\ndata: {\"first\":1}\n\n"))
      controller.enqueue(encode.encode("data: {\"last\":2}"))
      controller.close()
    },
  })
  const values: unknown[] = []
  const consumed = await consumeTurnResponse(new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  }), false, value => values.push(value))
  assert.deepEqual(values, [{ first: 1 }, { last: 2 }])
  assert.deepEqual(consumed, { sawDone: false, callerLimitReached: false })
})

test("turn response consumer recognizes completion and cancels on caller limits", async () => {
  const done = await consumeTurnResponse(new Response("data: [DONE]", {
    headers: { "content-type": "text/event-stream" },
  }), false, () => undefined)
  assert.equal(done.sawDone, true)

  const limited = await consumeTurnResponse(new Response("data: {\"text\":\"too much\"}\n", {
    headers: { "content-type": "text/event-stream" },
  }), false, () => { throw new CallerOutputLimitReached() })
  assert.deepEqual(limited, { sawDone: true, callerLimitReached: true })
})

test("turn response consumer rejects oversized declared generic streams", async () => {
  const response = new Response("small", {
    headers: {
      "content-type": "text/event-stream",
      "content-length": String(MAX_GENERIC_SUCCESS_RESPONSE_BYTES + 1),
    },
  })
  await assert.rejects(
    consumeTurnResponse(response, true, () => undefined),
    GenericResponseLimitError,
  )
})
