import assert from "node:assert/strict"
import test from "node:test"

import {
  createSmoothCodeStreamRenderer,
  visibleCharactersPerTick,
} from "../components/code-console/smooth-stream"
import { initialCodeStreamState } from "../components/code-console/stream"

test("Code stream keeps normal chunks on a one-character cadence", () => {
  assert.equal(visibleCharactersPerTick(1, false), 1)
  assert.equal(visibleCharactersPerTick(20, false), 1)
  assert.equal(visibleCharactersPerTick(64, false), 1)
  assert.equal(visibleCharactersPerTick(65, false), 2)
})

test("Code stream reveals a short reply one character at a time", async () => {
  const initial = initialCodeStreamState(null)
  const rendered: string[] = []
  const renderer = createSmoothCodeStreamRenderer({
    initialState: initial,
    intervalMs: 1,
    render: (_previous, state) => rendered.push(state.fullText),
  })
  const completed = { ...initial, fullText: "流式输出", streamDone: true }

  renderer.push(completed)
  await renderer.finish(completed)
  renderer.cancel()

  assert.deepEqual(rendered, ["流", "流式", "流式输", "流式输出"])
})

test("Code stream resets immediately when the authoritative text is replaced", () => {
  const initial = initialCodeStreamState(null)
  const rendered: string[] = []
  const renderer = createSmoothCodeStreamRenderer({
    initialState: { ...initial, fullText: "旧内容" },
    intervalMs: 1,
    render: (_previous, state) => rendered.push(state.fullText),
  })

  renderer.push({ ...initial, fullText: "重试", hadError: false })
  renderer.cancel()

  assert.deepEqual(rendered, ["重试"])
})
