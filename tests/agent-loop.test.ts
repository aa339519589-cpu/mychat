import assert from "node:assert/strict"
import test from "node:test"
import { runAgentLoop } from "../lib/llm/agent-loop"
import type { ModelMessage, ModelToolDefinition } from "../lib/llm/types"

const tool: ModelToolDefinition = {
  type: "function",
  function: {
    name: "lookup",
    description: "lookup",
    parameters: { type: "object", properties: {} },
  },
}

function completion(options: {
  content?: string
  finishReason?: string | null
  tokens?: number
  toolCalls?: Array<{ id: string; name: string; args: string }>
}) {
  return Response.json({
    choices: [{
      finish_reason: options.finishReason ?? "stop",
      message: {
        content: options.content ?? "",
        ...(options.toolCalls ? {
          tool_calls: options.toolCalls.map((call, index) => ({
            index,
            id: call.id,
            function: { name: call.name, arguments: call.args },
          })),
        } : {}),
      },
    }],
    usage: { total_tokens: options.tokens ?? 0 },
  })
}

function baseOptions(messages: ModelMessage[], fetcher: typeof fetch) {
  return {
    url: "https://model.example/v1/chat/completions",
    apiKey: "key",
    model: "model",
    adapter: "generic-openai" as const,
    thinking: false,
    messages,
    tools: [tool],
    emit: () => undefined,
    executeTool: async () => "ok",
    turnOptions: { fetcher },
  }
}

test("agent loop retries generic gateways without tools and reports cumulative usage", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "hello" }]
  const bodies: Array<Record<string, unknown>> = []
  const usage: number[] = []
  let calls = 0
  const fetcher: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    calls++
    return calls === 1
      ? new Response("unsupported tools", { status: 400 })
      : completion({ content: "plain answer", tokens: 7 })
  }
  const result = await runAgentLoop({
    ...baseOptions(messages, fetcher),
    maxRounds: 1,
    onUsage: total => usage.push(total),
  })
  assert.equal(result.totalTokens, 7)
  assert.equal(Array.isArray(bodies[0]?.tools), true)
  assert.equal("tools" in bodies[1], false)
  assert.deepEqual(usage, [0, 7])
})

test("agent loop executes valid tools, rejects malformed arguments, and emits final text", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "use tools" }]
  const executed: Array<{ name: string; input: unknown }> = []
  const checkpoints: number[] = []
  const phases: string[] = []
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return calls === 1
      ? completion({
          finishReason: "tool_calls",
          tokens: 3,
          toolCalls: [
            { id: "bad", name: "lookup", args: "{" },
            { id: "good", name: "lookup", args: "{\"id\":1}" },
          ],
        })
      : completion({ content: "final answer", tokens: 4 })
  }
  const result = await runAgentLoop({
    ...baseOptions(messages, fetcher),
    maxRounds: 1,
    executeTool: async (name, input) => {
      executed.push({ name, input })
      return "tool result"
    },
    onCheckpoint: current => { checkpoints.push(current.length) },
    onTurn: info => phases.push(info.phase),
  })
  assert.equal(result.totalTokens, 7)
  assert.deepEqual(executed, [{ name: "lookup", input: { id: 1 } }])
  assert.ok(messages.some(message => message.role === "tool" && message.tool_call_id === "bad"))
  assert.ok(messages.some(message => message.role === "tool" && message.content === "tool result"))
  assert.deepEqual(phases, ["round", "final-text"])
  assert.equal(checkpoints.length, 2)
})

test("agent loop idle continuation adds a caller-owned prompt and resumes", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "work" }]
  const prompts: number[] = []
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return completion({ content: calls === 1 ? "partial" : "done" })
  }
  await runAgentLoop({
    ...baseOptions(messages, fetcher),
    maxRounds: 3,
    idleContinuation: {
      maxContinuations: 1,
      prompt: ({ idleCount }) => {
        prompts.push(idleCount)
        return "continue autonomously"
      },
    },
  })
  assert.deepEqual(prompts, [0])
  assert.ok(messages.some(message => message.role === "assistant" && message.content === "partial"))
  assert.ok(messages.some(message => message.role === "user" && message.content === "continue autonomously"))
  assert.equal(calls, 2)
})

test("agent loop auto-continues length truncation and marks the configured ceiling", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "long answer" }]
  const emitted: string[] = []
  let calls = 0
  const fetcher: typeof fetch = async () => {
    calls++
    return completion({ content: calls === 1 ? "part one" : "part two", finishReason: "length" })
  }
  await runAgentLoop({
    ...baseOptions(messages, fetcher),
    maxRounds: 1,
    autoContinue: { maxContinuations: 1 },
    emit: event => { if ("text" in event && event.text) emitted.push(event.text) },
  })
  assert.equal(calls, 2)
  assert.ok(messages.some(message => message.role === "assistant" && message.content === "part one"))
  assert.match(emitted.join(""), /已输出至上限/)
})

test("agent loop reports an uncontinued transport truncation", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "stream" }]
  const emitted: string[] = []
  const fetcher: typeof fetch = async () => new Response(
    "data: {\"choices\":[{\"delta\":{\"content\":\"partial stream\"}}]}\n",
    { headers: { "content-type": "text/event-stream" } },
  )
  await runAgentLoop({
    ...baseOptions(messages, fetcher),
    maxRounds: 1,
    autoContinue: { maxContinuations: 0 },
    emit: event => { if ("text" in event && event.text) emitted.push(event.text) },
  })
  assert.match(emitted.join(""), /回复异常中断/)
})

test("agent loop stops after consecutive upstream failures", async () => {
  const messages: ModelMessage[] = [{ role: "user", content: "fail" }]
  const fetcher: typeof fetch = async () => new Response("offline", { status: 503 })
  await assert.rejects(runAgentLoop({
    ...baseOptions(messages, fetcher),
    adapter: "deepseek-openai",
    tools: [],
    maxRounds: 1,
  }), /模型服务.*503|模型连接连续失败/)
})
