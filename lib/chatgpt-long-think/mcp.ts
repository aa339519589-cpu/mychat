import {
  CHATGPT_LONG_THINK_PROTOCOL_VERSION,
  CHATGPT_LONG_THINK_SERVER_NAME,
  CHATGPT_LONG_THINK_SERVER_VERSION,
  MAX_SILENT_THINKING_GAP_MS,
  MIN_CHECKPOINT_INTERVAL_MS,
  MIN_PURE_THINKING_MS,
  RESPONSE_INTEGRITY_RULES,
  THINKING_STAGES,
  THINKING_TRIGGER_MESSAGE,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ThinkingClock,
  type ThinkingClockAction,
} from "./protocol"
import {
  checkpointWithClock,
  cleanText,
  clockFromCheckpoint,
  clockInstruction,
  clockJson,
  clockProgress,
  isRecord,
  settledClock,
  startedClock,
} from "./clock"
import {
  checkpointInput,
  checkpointInstruction,
  checkpointReady,
  evaluateCheckpoint,
  stableCheckpoint,
} from "./checkpoint"

export {
  CHATGPT_LONG_THINK_PROTOCOL_VERSION,
  CHATGPT_LONG_THINK_SERVER_NAME,
  CHATGPT_LONG_THINK_SERVER_VERSION,
  MIN_PURE_THINKING_MS,
} from "./protocol"
export type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "./protocol"

export const CHATGPT_LONG_THINK_TOOLS = [
  {
    name: "trigger_thinking",
    title: "Trigger Thinking",
    description: "One-tap user command. When called, immediately switch the current turn from fast/instant generation to thinking mode and continue the user's actual request in thinking mode.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  {
    name: "long_think_clock",
    title: "Pure thinking clock",
    description: `Enforce at least 30 seconds of active model thinking with no upper limit. Call start before thinking. Checkpoints must be ordered work products, at least ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s apart; a silent gap over ${MAX_SILENT_THINKING_GAP_MS / 1000}s is discarded. Call pause immediately before every external tool call and resume immediately after it returns; external-tool time is excluded.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "pause", "resume"] },
        checkpoint: { type: "string", description: "Clock checkpoint returned by this tool or long_think_checkpoint." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  {
    name: "long_think_checkpoint",
    title: "Long Think checkpoint",
    description: `Use this for every user request, including ordinary chat. Submit six ordered work products in stages decompose, analyze, verify, challenge, recheck, synthesize. Each stage must be new, at least ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s after the previous one, and contain concrete progress. The server rejects done=true until at least ${MIN_PURE_THINKING_MS / 1000}s of active thinking and all six stages are recorded. A silent gap over ${MAX_SILENT_THINKING_GAP_MS / 1000}s is discarded. External-tool time counts only when bracketed by long_think_clock pause/resume. There is no upper limit.`,
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The user's actual objective, kept stable across calls." },
        stage: { type: "string", enum: THINKING_STAGES.map(stage => stage.name), description: "Required ordered stage for this checkpoint: decompose, analyze, verify, challenge, recheck, synthesize." },
        checkpoint: { type: "string", description: "Optional checkpoint returned by the previous call." },
        progress: { type: "string", description: "Compact factual state of work completed so far. Do not include hidden chain-of-thought; include conclusions, evidence, calculations, and decisions needed to continue." },
        unresolved: { type: "array", items: { type: "string" }, description: "Concrete gaps that still block completion." },
        nextActions: { type: "array", items: { type: "string" }, description: "Specific next work items." },
        evidence: { type: "array", items: { type: "string" }, description: "Optional key evidence, citations, or verified facts needed for continuity." },
        proposedAnswer: { type: "string", description: "Draft final answer only when nearly complete." },
        done: { type: "boolean", description: "True only when all material gaps are closed and the final answer is ready." }
      },
      required: ["objective", "stage", "progress", "unresolved", "nextActions", "done"],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false
    }
  },
  {
    name: "long_think_resume",
    title: "Resume Long Think",
    description: "Use when a previous Long Think checkpoint is present in the conversation and the user asks to continue. It reconstructs a concise continuation instruction without exposing hidden chain-of-thought.",
    inputSchema: {
      type: "object",
      properties: {
        checkpoint: { type: "string", description: "Checkpoint string previously returned by long_think_checkpoint." },
        instruction: { type: "string", description: "Optional new user instruction to incorporate." }
      },
      required: ["checkpoint"],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false
    }
  }
] as const

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    ...(structuredContent ? { structuredContent } : {}),
    content: [{ type: "text", text }]
  }
}

function parseClockAction(value: unknown): { action: ThinkingClockAction; checkpoint: string } | null {
  if (!isRecord(value)) return null
  const action = value.action === "start" || value.action === "pause" || value.action === "resume" ? value.action : null
  if (!action) return null
  return { action, checkpoint: cleanText(value.checkpoint) }
}

function callTriggerThinking(args: unknown) {
  if (args !== undefined && args !== null && (!isRecord(args) || Object.keys(args).length > 0)) {
    return { isError: true, ...textResult("trigger_thinking takes no arguments.") }
  }
  return textResult(
    THINKING_TRIGGER_MESSAGE,
    { thinking: true, mode: "thinking", trigger: "user_button", requestedAt: Date.now() },
  )
}

function callClock(args: unknown) {
  const input = parseClockAction(args)
  if (!input) return { isError: true, ...textResult("Invalid clock input: action must be start, pause, or resume.") }

  if (input.action === "start") {
    const clock = startedClock()
    return textResult(
      `${THINKING_TRIGGER_MESSAGE} Active pure-thinking clock started. Think continuously for at least ${MIN_PURE_THINKING_MS / 1000} seconds; there is no upper limit. Submit fresh factual progress at least every ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s; a silent gap over ${MAX_SILENT_THINKING_GAP_MS / 1000}s is discarded. Before every external tool call, pause this clock; after the tool returns, resume it. Do not send any user-facing text until long_think_checkpoint returns done=true.`,
      { checkpoint: clockJson(clock), pureThinkingMs: 0, remainingMs: MIN_PURE_THINKING_MS, phase: clock.phase, checkpointCount: 0, stageIndex: 0, nextStage: THINKING_STAGES[0].name, thinking: true, mode: "thinking", trigger: "clock_start" },
    )
  }

  const clock = clockFromCheckpoint(input.checkpoint)
  if (!clock) return { isError: true, ...textResult("Clock checkpoint is missing or invalid. Call long_think_clock(action=\"start\") first.") }
  if (input.action === "pause") {
    const paused = settledClock(clock)
    const next: ThinkingClock = { ...paused, phase: "paused", lastThinkingAt: null }
    return textResult(
      "Pure-thinking clock paused. Call long_think_clock(action=\"resume\") immediately after the external tool returns. The tool's time is excluded.",
      { checkpoint: checkpointWithClock(input.checkpoint, next), pureThinkingMs: next.pureThinkingMs, remainingMs: Math.max(0, MIN_PURE_THINKING_MS - next.pureThinkingMs), phase: next.phase },
    )
  }

  const resumed: ThinkingClock = { ...clock, phase: "thinking", lastThinkingAt: Date.now() }
  return textResult(
    "Pure-thinking clock resumed. Continue thinking; do not finish until the 30-second minimum is reached and the task is closed.",
    { checkpoint: checkpointWithClock(input.checkpoint, resumed), pureThinkingMs: resumed.pureThinkingMs, remainingMs: Math.max(0, MIN_PURE_THINKING_MS - resumed.pureThinkingMs), phase: resumed.phase },
  )
}

function callCheckpoint(args: unknown) {
  const input = checkpointInput(args)
  if (!input) {
    return { isError: true, ...textResult("Invalid checkpoint input: objective, stage, and progress are required, and unresolved/nextActions/done must match the schema.") }
  }
  const priorClock = clockFromCheckpoint(input.checkpoint ?? "")
  const now = Date.now()
  const evaluation = evaluateCheckpoint(input, priorClock, now)
  const { clock } = evaluation
  const actuallyDone = checkpointReady(input, evaluation)
  const instruction = checkpointInstruction(evaluation, actuallyDone)
  const result = textResult(instruction, {
    checkpoint: stableCheckpoint(input, clock, actuallyDone),
    done: actuallyDone,
    unresolvedCount: input.unresolved.length,
    nextActionCount: input.nextActions.length,
    ...clockProgress(clock),
    stage: input.stage,
    stageAccepted: evaluation.acceptedProgress,
    expectedStage: THINKING_STAGES[Math.min(clock.stageIndex, THINKING_STAGES.length - 1)]?.name ?? "complete",
    continuationInstruction: instruction
  })
  return actuallyDone ? result : { isError: true, ...result }
}

function callResume(args: unknown) {
  if (!isRecord(args)) return { isError: true, ...textResult("Invalid resume input.") }
  const checkpoint = cleanText(args.checkpoint)
  if (!checkpoint) return { isError: true, ...textResult("checkpoint is required.") }
  const instruction = cleanText(args.instruction, 8_000)
  const suffix = instruction ? ` New user instruction: ${instruction}` : ""
  const priorClock = clockFromCheckpoint(checkpoint)
  const resumedClock = priorClock ? { ...priorClock, phase: "thinking" as const, lastThinkingAt: Date.now() } : null
  return textResult(
    `Resume from this compact checkpoint and continue the unfinished work. ${clockInstruction(resumedClock)} Do not claim completion until all material gaps are closed. Do not expose hidden chain-of-thought.${suffix}`,
    { checkpoint: resumedClock ? checkpointWithClock(checkpoint, resumedClock) : checkpoint, instruction, ...(resumedClock ? clockProgress(resumedClock) : {}) }
  )
}

export function callChatGptLongThinkTool(name: unknown, args: unknown): unknown {
  if (name === "trigger_thinking") return callTriggerThinking(args)
  if (name === "long_think_clock") return callClock(args)
  if (name === "long_think_checkpoint") return callCheckpoint(args)
  if (name === "long_think_resume") return callResume(args)
  return { isError: true, ...textResult(`Unknown tool: ${cleanText(name, 200) || "(empty)"}`) }
}

export function handleChatGptLongThinkRpc(body: JsonRpcRequest): JsonRpcResponse | null {
  const id = body.id ?? null
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } }
  }

  if (body.method.startsWith("notifications/")) return null

  if (body.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: CHATGPT_LONG_THINK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: CHATGPT_LONG_THINK_SERVER_NAME, version: CHATGPT_LONG_THINK_SERVER_VERSION },
        instructions: `If trigger_thinking is called, it is the user's explicit command to switch the current turn from fast/instant generation to thinking mode. Continue the user's actual request in thinking mode and do not answer in fast mode. For every user request, including ordinary or simple chat, call long_think_clock(action="start") before drafting any user-facing text. Then submit six ordered, concrete work products through long_think_checkpoint: decompose, analyze, verify, challenge, recheck, synthesize. Each checkpoint must be a new stage at least ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s after the previous one; a silent gap over ${MAX_SILENT_THINKING_GAP_MS / 1000}s resets the active run. The model must accumulate at least ${MIN_PURE_THINKING_MS / 1000} seconds of pure thinking and finish all six stages before a final answer; there is no upper limit. Tool time is excluded only when every external tool call is bracketed by long_think_clock pause/resume. You must not send any user-facing text until long_think_checkpoint returns done=true. Continue after every blocked checkpoint. Preserve conclusions and evidence in checkpoint state; never include or request hidden chain-of-thought.\n${RESPONSE_INTEGRITY_RULES}`
      }
    }
  }

  if (body.method === "ping") return { jsonrpc: "2.0", id, result: {} }

  if (body.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: CHATGPT_LONG_THINK_TOOLS } }
  }

  if (body.method === "tools/call") {
    const params = isRecord(body.params) ? body.params : {}
    return { jsonrpc: "2.0", id, result: callChatGptLongThinkTool(params.name, params.arguments) }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }
}
