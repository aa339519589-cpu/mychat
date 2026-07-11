import test from "node:test"
import assert from "node:assert/strict"
import { planChatStreamFinalization } from "../lib/chat-stream-finalization"

test("stopped streams persist partial output and remove empty placeholders", () => {
  assert.deepEqual(planChatStreamFinalization({ hasOutput: true, aborted: true, terminalError: null }), {
    kind: "persist",
  })
  assert.deepEqual(planChatStreamFinalization({ hasOutput: false, aborted: true, terminalError: null }), {
    kind: "remove",
  })
})

test("stream errors retain partial output but surface empty failures", () => {
  assert.deepEqual(planChatStreamFinalization({ hasOutput: true, aborted: false, terminalError: "连接中断" }), {
    kind: "persist",
    warning: "生成提前结束：连接中断",
  })
  assert.deepEqual(planChatStreamFinalization({ hasOutput: false, aborted: false, terminalError: "连接中断" }), {
    kind: "error",
    message: "连接中断",
  })
})
