import test from "node:test"
import assert from "node:assert/strict"
import {
  CHATGPT_LONG_THINK_PROTOCOL_VERSION,
  CHATGPT_LONG_THINK_TOOLS,
  MIN_PURE_THINKING_MS,
  callChatGptLongThinkTool,
  handleChatGptLongThinkRpc,
} from "../lib/chatgpt-long-think/mcp"

test("ChatGPT Long Think MCP initializes as a stateless tools server", () => {
  const response = handleChatGptLongThinkRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: CHATGPT_LONG_THINK_PROTOCOL_VERSION },
  })
  assert.equal(response?.jsonrpc, "2.0")
  assert.equal(response?.id, 1)
  const result = response?.result as Record<string, unknown>
  assert.equal(result.protocolVersion, CHATGPT_LONG_THINK_PROTOCOL_VERSION)
  assert.deepEqual(result.capabilities, { tools: {} })
  assert.match(String(result.instructions), /Answer the user's exact claim/)
  assert.match(String(result.instructions), /Never paraphrase or restate/)
  assert.match(String(result.instructions), /Never add caveats/)
  assert.match(String(result.instructions), /ask one focused clarifying question/)
  assert.match(String(result.instructions), /at least 30 seconds of pure thinking/)
  assert.match(String(result.instructions), /no upper limit/)
  assert.match(String(result.instructions), /pause.*resume/)
})

test("lists the clock, checkpoint, and resume tools as read-only", () => {
  const response = handleChatGptLongThinkRpc({ jsonrpc: "2.0", id: "tools", method: "tools/list" })
  const result = response?.result as { tools: typeof CHATGPT_LONG_THINK_TOOLS }
  assert.equal(result.tools.length, 3)
  assert.deepEqual(result.tools.map(tool => tool.name), ["long_think_clock", "long_think_checkpoint", "long_think_resume"])
  assert.ok(result.tools.every(tool => tool.annotations.readOnlyHint === true))
})

test("checkpoint forces continuation while material gaps remain", () => {
  const result = callChatGptLongThinkTool("long_think_checkpoint", {
    objective: "Prove the claim",
    progress: "Reduced the problem to two remaining lemmas.",
    unresolved: ["Lemma B is still open"],
    nextActions: ["Prove Lemma B"],
    evidence: ["Lemma A verified"],
    proposedAnswer: "Premature draft",
    done: true,
  }) as {
    structuredContent: { checkpoint: string; done: boolean; continuationInstruction: string }
    content: Array<{ type: string; text: string }>
  }
  assert.equal(result.structuredContent.done, false)
  assert.match(result.structuredContent.continuationInstruction, /Continue working now/)
  assert.match(result.structuredContent.continuationInstruction, /long_think_clock/)
  assert.match(result.content[0]?.text ?? "", /Do not give the user a final answer yet/)
  const checkpoint = JSON.parse(result.structuredContent.checkpoint) as Record<string, unknown>
  assert.equal(checkpoint.objective, "Prove the claim")
  assert.equal(checkpoint.done, false)
})

test("checkpoint accepts closure only with no gaps and a proposed answer", () => {
  const originalNow = Date.now
  Date.now = () => MIN_PURE_THINKING_MS + 1_000
  try {
    const clock = JSON.stringify({ clock: { version: 1, pureThinkingMs: 0, phase: "thinking", lastThinkingAt: 0 } })
    const result = callChatGptLongThinkTool("long_think_checkpoint", {
      objective: "Solve the problem",
      checkpoint: clock,
      progress: "All required cases are verified.",
      unresolved: [],
      nextActions: [],
      evidence: ["All cases checked"],
      proposedAnswer: "The result is established.",
      done: true,
    }) as { structuredContent: { done: boolean; pureThinkingMs: number }; content: Array<{ text: string }> }
    assert.equal(result.structuredContent.done, true)
    assert.equal(result.structuredContent.pureThinkingMs, MIN_PURE_THINKING_MS + 1_000)
    assert.match(result.content[0]?.text ?? "", /Closure accepted/)
    assert.match(result.content[0]?.text ?? "", /Response integrity rules apply to every reply/)
  } finally {
    Date.now = originalNow
  }
})

test("clock excludes external-tool time and keeps accumulating pure thinking", () => {
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  try {
    const started = callChatGptLongThinkTool("long_think_clock", { action: "start" }) as { structuredContent: { checkpoint: string } }
    now = 10_000
    const paused = callChatGptLongThinkTool("long_think_clock", { action: "pause", checkpoint: started.structuredContent.checkpoint }) as { structuredContent: { checkpoint: string; pureThinkingMs: number; phase: string } }
    assert.equal(paused.structuredContent.pureThinkingMs, 10_000)
    assert.equal(paused.structuredContent.phase, "paused")
    now = 100_000
    const resumed = callChatGptLongThinkTool("long_think_clock", { action: "resume", checkpoint: paused.structuredContent.checkpoint }) as { structuredContent: { checkpoint: string; pureThinkingMs: number; phase: string } }
    assert.equal(resumed.structuredContent.pureThinkingMs, 10_000)
    assert.equal(resumed.structuredContent.phase, "thinking")
    now = 119_999
    const checkpoint = callChatGptLongThinkTool("long_think_checkpoint", {
      objective: "Solve the problem",
      checkpoint: resumed.structuredContent.checkpoint,
      progress: "Still checking the final case.",
      unresolved: ["Final case"],
      nextActions: ["Check final case"],
      done: false,
    }) as { structuredContent: { checkpoint: string; pureThinkingMs: number; remainingMs: number } }
    assert.equal(checkpoint.structuredContent.pureThinkingMs, 29_999)
    assert.equal(checkpoint.structuredContent.remainingMs, 1)
  } finally {
    Date.now = originalNow
  }
})

test("closure stays blocked until the pure-thinking minimum is reached", () => {
  const originalNow = Date.now
  Date.now = () => MIN_PURE_THINKING_MS - 1
  try {
    const result = callChatGptLongThinkTool("long_think_checkpoint", {
      objective: "Solve the problem",
      checkpoint: JSON.stringify({ clock: { version: 1, pureThinkingMs: 0, phase: "thinking", lastThinkingAt: 0 } }),
      progress: "Candidate answer is ready.",
      unresolved: [],
      nextActions: [],
      proposedAnswer: "The result is established.",
      done: true,
    }) as { structuredContent: { done: boolean; remainingMs: number }; content: Array<{ text: string }> }
    assert.equal(result.structuredContent.done, false)
    assert.equal(result.structuredContent.remainingMs, 1)
    assert.match(result.content[0]?.text ?? "", /Do not finish yet/)
  } finally {
    Date.now = originalNow
  }
})

test("resume preserves the full checkpoint while restarting the thinking segment", () => {
  const result = callChatGptLongThinkTool("long_think_checkpoint", {
    objective: "Solve the problem",
    checkpoint: JSON.stringify({ clock: { version: 1, pureThinkingMs: 5_000, phase: "paused", lastThinkingAt: null } }),
    progress: "Saved progress.",
    unresolved: ["One check"],
    nextActions: ["Perform the check"],
    done: false,
  }) as { structuredContent: { checkpoint: string } }
  const resumed = callChatGptLongThinkTool("long_think_resume", {
    checkpoint: result.structuredContent.checkpoint,
    instruction: "also verify the edge case",
  }) as { structuredContent: { checkpoint: string; instruction: string }; content: Array<{ text: string }> }
  const checkpoint = JSON.parse(resumed.structuredContent.checkpoint) as Record<string, unknown>
  assert.equal(checkpoint.objective, "Solve the problem")
  assert.equal(resumed.structuredContent.instruction, "also verify the edge case")
  assert.match(resumed.content[0]?.text ?? "", /continue the unfinished work/i)
})

test("resume returns a continuation instruction without requiring hidden reasoning", () => {
  const result = callChatGptLongThinkTool("long_think_resume", {
    checkpoint: "{\"version\":1}",
    instruction: "also verify the edge case",
  }) as { structuredContent: { checkpoint: string; instruction: string }; content: Array<{ text: string }> }
  assert.equal(result.structuredContent.checkpoint, "{\"version\":1}")
  assert.equal(result.structuredContent.instruction, "also verify the edge case")
  assert.match(result.content[0]?.text ?? "", /continue the unfinished work/i)
})

test("MCP notifications do not produce JSON-RPC responses", () => {
  assert.equal(handleChatGptLongThinkRpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null)
})
