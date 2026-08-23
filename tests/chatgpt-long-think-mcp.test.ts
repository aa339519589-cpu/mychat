import test from "node:test"
import assert from "node:assert/strict"
import {
  CHATGPT_LONG_THINK_PROTOCOL_VERSION,
  CHATGPT_LONG_THINK_TOOLS,
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
})

test("lists the long-think checkpoint and resume tools as read-only", () => {
  const response = handleChatGptLongThinkRpc({ jsonrpc: "2.0", id: "tools", method: "tools/list" })
  const result = response?.result as { tools: typeof CHATGPT_LONG_THINK_TOOLS }
  assert.equal(result.tools.length, 2)
  assert.deepEqual(result.tools.map(tool => tool.name), ["long_think_checkpoint", "long_think_resume"])
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
  assert.match(result.content[0]?.text ?? "", /Do not give the user a final answer yet/)
  const checkpoint = JSON.parse(result.structuredContent.checkpoint) as Record<string, unknown>
  assert.equal(checkpoint.objective, "Prove the claim")
  assert.equal(checkpoint.done, true)
})

test("checkpoint accepts closure only with no gaps and a proposed answer", () => {
  const result = callChatGptLongThinkTool("long_think_checkpoint", {
    objective: "Solve the problem",
    progress: "All required cases are verified.",
    unresolved: [],
    nextActions: [],
    evidence: ["All cases checked"],
    proposedAnswer: "The result is established.",
    done: true,
  }) as { structuredContent: { done: boolean }; content: Array<{ text: string }> }
  assert.equal(result.structuredContent.done, true)
  assert.match(result.content[0]?.text ?? "", /Closure accepted/)
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
