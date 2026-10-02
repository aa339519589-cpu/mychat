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
  assert.match(String(result.instructions), /every user request/)
  assert.match(String(result.instructions), /must not send any user-facing text until long_think_checkpoint returns done=true/)
})

test("lists the thinking trigger, clock, checkpoint, and resume tools as read-only", () => {
  const response = handleChatGptLongThinkRpc({ jsonrpc: "2.0", id: "tools", method: "tools/list" })
  const result = response?.result as { tools: typeof CHATGPT_LONG_THINK_TOOLS }
  assert.equal(result.tools.length, 4)
  assert.deepEqual(result.tools.map(tool => tool.name), ["trigger_thinking", "long_think_clock", "long_think_checkpoint", "long_think_resume"])
  assert.ok(result.tools.every(tool => tool.annotations.readOnlyHint === true))
})

const stages = ["decompose", "analyze", "verify", "challenge", "recheck", "synthesize"] as const

function submitStage(stageIndex: number, checkpoint: string, now: number, done = false) {
  Date.now = () => now
  return callChatGptLongThinkTool("long_think_checkpoint", {
    objective: "Solve the problem",
    stage: stages[stageIndex],
    checkpoint,
    progress: `Stage ${stageIndex}: verified distinct work product for the requested problem.`,
    unresolved: stageIndex === 5 && done ? [] : ["Validate the remaining condition"],
    nextActions: stageIndex === 5 && done ? [] : ["Check the remaining condition"],
    evidence: stageIndex === 2 ? ["Checked the primary condition"] : [],
    proposedAnswer: stageIndex === 5 && done ? "The result is established." : "",
    done,
  }) as { structuredContent: { checkpoint: string; done: boolean; pureThinkingMs: number; remainingMs: number }; content: Array<{ text: string }> }
}

test("checkpoint forces continuation while material gaps remain", () => {
  const originalNow = Date.now
  Date.now = () => 0
  try {
    const started = callChatGptLongThinkTool("long_think_clock", { action: "start" }) as { structuredContent: { checkpoint: string } }
    const result = submitStage(0, started.structuredContent.checkpoint, MIN_PURE_THINKING_MS / 10)
  assert.equal(result.structuredContent.done, false)
    assert.equal(result.structuredContent.pureThinkingMs, MIN_PURE_THINKING_MS / 10)
    assert.match(result.content[0]?.text ?? "", /Do not give the user a final answer yet/)
  const checkpoint = JSON.parse(result.structuredContent.checkpoint) as Record<string, unknown>
    assert.equal(checkpoint.objective, "Solve the problem")
  assert.equal(checkpoint.done, false)
  } finally {
    Date.now = originalNow
  }
})

test("checkpoint accepts closure only with no gaps and a proposed answer", () => {
  const originalNow = Date.now
  try {
    Date.now = () => 0
    const started = callChatGptLongThinkTool("long_think_clock", { action: "start" }) as { structuredContent: { checkpoint: string } }
    let checkpoint = started.structuredContent.checkpoint
    let result: ReturnType<typeof submitStage> | undefined
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      result = submitStage(stageIndex, checkpoint, (stageIndex + 1) * 5_000, stageIndex === stages.length - 1)
      checkpoint = result.structuredContent.checkpoint
    }
    assert.ok(result)
    assert.equal(result.structuredContent.done, true)
    assert.equal(result.structuredContent.pureThinkingMs, MIN_PURE_THINKING_MS)
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
    now = 105_000
    const first = submitStage(0, resumed.structuredContent.checkpoint, now)
    assert.equal(first.structuredContent.pureThinkingMs, 15_000)
    now = 110_000
    const second = submitStage(1, first.structuredContent.checkpoint, now)
    assert.equal(second.structuredContent.pureThinkingMs, 20_000)
  } finally {
    Date.now = originalNow
  }
})

test("closure stays blocked until the pure-thinking minimum is reached", () => {
  const originalNow = Date.now
  try {
    Date.now = () => 0
    const started = callChatGptLongThinkTool("long_think_clock", { action: "start" }) as { structuredContent: { checkpoint: string } }
    let checkpoint = started.structuredContent.checkpoint
    let result: ReturnType<typeof submitStage> | undefined
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      const now = stageIndex === stages.length - 1 ? MIN_PURE_THINKING_MS - 1 : (stageIndex + 1) * 5_000
      result = submitStage(stageIndex, checkpoint, now, stageIndex === stages.length - 1)
      checkpoint = result.structuredContent.checkpoint
    }
    assert.ok(result)
    assert.equal(result.structuredContent.done, false)
    assert.equal(result.structuredContent.remainingMs, 1)
    assert.match(result.content[0]?.text ?? "", /Do not finish yet/)
  } finally {
    Date.now = originalNow
  }
})

test("resume preserves the full checkpoint while restarting the thinking segment", () => {
  const originalNow = Date.now
  try {
    Date.now = () => 0
    const started = callChatGptLongThinkTool("long_think_clock", { action: "start" }) as { structuredContent: { checkpoint: string } }
    const result = submitStage(0, started.structuredContent.checkpoint, 3_000)
    const resumed = callChatGptLongThinkTool("long_think_resume", {
      checkpoint: result.structuredContent.checkpoint,
      instruction: "also verify the edge case",
    }) as { structuredContent: { checkpoint: string; instruction: string }; content: Array<{ text: string }> }
    const checkpoint = JSON.parse(resumed.structuredContent.checkpoint) as Record<string, unknown>
    assert.equal(checkpoint.objective, "Solve the problem")
    assert.equal(resumed.structuredContent.instruction, "also verify the edge case")
    assert.match(resumed.content[0]?.text ?? "", /continue the unfinished work/i)
  } finally {
    Date.now = originalNow
  }
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
