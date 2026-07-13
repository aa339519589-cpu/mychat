import assert from "node:assert/strict"
import test from "node:test"

import {
  initialCodeStreamState,
  reduceCodeStreamEvent,
} from "../components/code-console/stream"

test("code stream reducer preserves event precedence and publish signals", () => {
  let state = initialCodeStreamState("task-old")
  state = reduceCodeStreamEvent(state, { data: { taskId: "task-new", text: "ignored" } })
  assert.equal(state.taskId, "task-new")
  assert.equal(state.fullText, "")

  state = reduceCodeStreamEvent(state, { data: { step: { kind: "deploy", label: "准备发布" } } })
  state = reduceCodeStreamEvent(state, { data: { text: "可以确认发布" } })
  state = reduceCodeStreamEvent(state, { done: true })
  assert.equal(state.steps.length, 1)
  assert.equal(state.fullText, "可以确认发布")
  assert.equal(state.publishPending, true)
  assert.equal(state.streamDone, true)
})

test("code stream errors replace partial model text", () => {
  let state = initialCodeStreamState(null)
  state = reduceCodeStreamEvent(state, { data: { text: "partial" } })
  state = reduceCodeStreamEvent(state, { data: { error: "upstream failed" } })
  assert.equal(state.fullText, "upstream failed")
  assert.equal(state.hadError, true)
})
