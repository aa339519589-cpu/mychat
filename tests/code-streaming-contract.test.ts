import assert from "node:assert/strict"
import test from "node:test"

import { createCodeEventCollector } from "../lib/code-agent/runtime"

test("Code forwards the first model text delta immediately", () => {
  const sent: object[] = []
  const collector = createCodeEventCollector({ send: event => sent.push(event) })

  collector.emit({ text: "首" })
  collector.emit({ text: "Token" })

  assert.deepEqual(sent, [{ text: "首" }, { text: "Token" }])
  assert.equal(collector.getFinalText(), "首Token")
})

test("Code still suppresses hidden reasoning while streaming visible text", () => {
  const sent: object[] = []
  const collector = createCodeEventCollector({ send: event => sent.push(event) })

  collector.emit({ thinking: "内部推理" })
  collector.emit({ text: "可见回复" })

  assert.deepEqual(sent, [{ text: "可见回复" }])
  assert.equal(collector.getFinalText(), "可见回复")
})
