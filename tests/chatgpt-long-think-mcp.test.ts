import test from "node:test"
import assert from "node:assert/strict"
import {
  CHATGPT_LONG_THINK_PROTOCOL_VERSION,
  CHATGPT_LONG_THINK_TOOLS,
  MIN_PURE_THINKING_MS,
  callChatGptLongThinkTool,
  handleChatGptLongThinkRpc,
} from "../lib/chatgpt-long-think/mcp"

const STAGES = ["decompose", "analyze", "verify", "challenge", "recheck", "synthesize"] as const
type Stage = typeof STAGES[number]
type ToolResult = { structuredContent: Record<string, unknown>; content: Array<{ type?: string; text: string }> }

function tool(name: string, args: unknown): ToolResult {
  return callChatGptLongThinkTool(name, args) as ToolResult
}

function stageInput(stage: Stage, checkpoint: string) {
  const isFinal = stage === "synthesize"
  return {
    objective: "Solve the problem",
    stage,
    checkpoint,
    progress: `Completed the ${stage} stage with a new checked result and recorded its implications.`,
    unresolved: isFinal ? [] : [`Open issue after ${stage}`],
    nextActions: isFinal ? [] : [`Resolve the open issue after ${stage}`],
    evidence: stage === "verify" ? ["Checked the key calculation against the stated assumptions"] : [],
    proposedAnswer: isFinal ? "The verified result is established." : "",
    done: isFinal,
  }
}

function submitStage(stage: Stage, checkpoint: string): ToolResult {
  return tool("long_think_checkpoint", stageInput(stage, checkpoint))
}

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
  assert.deepEqual(result.tools.map(tool => tool.name), ["trigger_thinking", "long_think_clock", "long_think_checkpoint", "long_think_resume"])
  assert.ok(result.tools.every(tool => tool.annotations.readOnlyHint === true))
})

test("checkpoint blocks closure while material gaps remain", () => {
  const result = submitStage("decompose", "")
  assert.equal(result.structuredContent.done, false)
  assert.match(String(result.structuredContent.continuationInstruction), /Continue working now/)
  assert.match(String(result.structuredContent.continuationInstruction), /clock was started by this fallback call/)
  assert.match(result.content[0]?.text ?? "", /Do not give the user a final answer yet/)
  const checkpoint = JSON.parse(String(result.structuredContent.checkpoint)) as Record<string, unknown>
  assert.equal(checkpoint.objective, "Solve the problem")
  assert.equal(checkpoint.done, false)
})

test("checkpoint accepts closure after all ordered work stages and the active-time minimum", () => {
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  try {
    let checkpoint = tool("long_think_clock", { action: "start" }).structuredContent.checkpoint as string
    let result: ToolResult | undefined
    for (const stage of STAGES) {
      now += 5_000
      result = submitStage(stage, checkpoint)
      checkpoint = result.structuredContent.checkpoint as string
    }
    assert.equal(result?.structuredContent.done, true)
    assert.equal(result?.structuredContent.pureThinkingMs, MIN_PURE_THINKING_MS)
    assert.match(result?.content[0]?.text ?? "", /Closure accepted/)
    assert.match(result?.content[0]?.text ?? "", /Response integrity rules apply to every reply/)
  } finally {
    Date.now = originalNow
  }
})

test("clock excludes external-tool time while ordered checkpoints preserve active time", () => {
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  try {
    const started = tool("long_think_clock", { action: "start" })
    now = 10_000
    const paused = tool("long_think_clock", { action: "pause", checkpoint: started.structuredContent.checkpoint })
    assert.equal(paused.structuredContent.pureThinkingMs, 10_000)
    assert.equal(paused.structuredContent.phase, "paused")
    now = 100_000
    const resumed = tool("long_think_clock", { action: "resume", checkpoint: paused.structuredContent.checkpoint })
    assert.equal(resumed.structuredContent.pureThinkingMs, 10_000)
    assert.equal(resumed.structuredContent.phase, "thinking")

    let checkpoint = resumed.structuredContent.checkpoint as string
    for (const stage of STAGES.slice(0, 3)) {
      now += 5_000
      checkpoint = submitStage(stage, checkpoint).structuredContent.checkpoint as string
    }
    now += 4_999
    const last = submitStage("challenge", checkpoint)
    assert.equal(last.structuredContent.pureThinkingMs, 29_999)
    assert.equal(last.structuredContent.remainingMs, 1)
    assert.equal(last.structuredContent.done, false)
  } finally {
    Date.now = originalNow
  }
})

test("closure remains blocked one millisecond below the active-time minimum", () => {
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  try {
    let checkpoint = tool("long_think_clock", { action: "start" }).structuredContent.checkpoint as string
    for (const stage of STAGES.slice(0, 5)) {
      now += 5_000
      checkpoint = submitStage(stage, checkpoint).structuredContent.checkpoint as string
    }
    now = MIN_PURE_THINKING_MS - 1
    const result = submitStage("synthesize", checkpoint)
    assert.equal(result.structuredContent.done, false)
    assert.equal(result.structuredContent.remainingMs, 1)
    assert.match(result.content[0]?.text ?? "", /Do not finish yet/)
  } finally {
    Date.now = originalNow
  }
})

test("resume preserves the full checkpoint while restarting the thinking segment", () => {
  const originalNow = Date.now
  let now = 0
  Date.now = () => now
  try {
    const started = tool("long_think_clock", { action: "start" })
    now = 5_000
    const first = submitStage("decompose", started.structuredContent.checkpoint as string)
    now = 90_000
    const resumed = tool("long_think_resume", {
      checkpoint: first.structuredContent.checkpoint,
      instruction: "also verify the edge case",
    })
    const checkpoint = JSON.parse(resumed.structuredContent.checkpoint as string) as Record<string, unknown>
    assert.equal(checkpoint.objective, "Solve the problem")
    assert.equal(resumed.structuredContent.instruction, "also verify the edge case")
    assert.equal(resumed.structuredContent.stageIndex, 1)
    assert.match(resumed.content[0]?.text ?? "", /continue the unfinished work/i)
  } finally {
    Date.now = originalNow
  }
})

test("resume returns a continuation instruction for a legacy checkpoint without clock state", () => {
  const result = tool("long_think_resume", {
    checkpoint: "{\"version\":1}",
    instruction: "also verify the edge case",
  })
  assert.equal(result.structuredContent.checkpoint, "{\"version\":1}")
  assert.equal(result.structuredContent.instruction, "also verify the edge case")
  assert.match(result.content[0]?.text ?? "", /continue the unfinished work/i)
})

test("MCP notifications do not produce JSON-RPC responses", () => {
  assert.equal(handleChatGptLongThinkRpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null)
})
