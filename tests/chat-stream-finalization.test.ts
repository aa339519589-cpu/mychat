import test from "node:test"
import assert from "node:assert/strict"
import { planChatStreamFinalization } from "../lib/chat-stream-finalization"
import { finalizeChatStream } from "../components/literary-chat/chat-stream-finalizer"

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

test("authoritative terminal unlocks generation when the local cache stalls", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  const statuses: string[] = []
  let cleared = false
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      indexedDB: { open: () => ({}) },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
  })

  try {
    const status = await Promise.race([
      finalizeChatStream({
        userId: "user",
        conversationId: "conversation",
        assistantMessageId: "assistant",
        controller: new AbortController(),
        generationId: "generation",
        showTokenUsage: false,
        fullReply: "完整回复",
        fullThinking: "",
        fullMedia: [],
        terminalError: null,
        authoritativeTerminal: {
          status: "completed",
          content: "完整回复",
          thinking: "",
          media: [],
          sequence: 3,
          error: null,
        },
        terminalProtocolExpected: true,
        aborted: false,
        setConversations: () => undefined,
        markGeneration: (_conversationId, patch) => { statuses.push(patch.status) },
        clearAbort: () => { cleared = true },
        flushStreamMessage: () => undefined,
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("terminal finalization remained blocked")), 500)
      }),
    ])

    assert.equal(status, "completed")
    assert.deepEqual(statuses, ["completed"])
    assert.equal(cleared, true)
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
