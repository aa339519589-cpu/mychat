export const CHATGPT_LONG_THINK_PROTOCOL_VERSION = "2025-06-18"
export const CHATGPT_LONG_THINK_SERVER_NAME = "mychat-long-think"
export const CHATGPT_LONG_THINK_SERVER_VERSION = "1.0.0"

export type JsonRpcId = string | number | null
export type JsonRpcRequest = {
  jsonrpc?: unknown
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}

export type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type LongThinkCheckpointInput = {
  objective: string
  checkpoint?: string
  progress: string
  unresolved: string[]
  nextActions: string[]
  evidence?: string[]
  proposedAnswer?: string
  done?: boolean
}

const MAX_TEXT = 24_000
const MAX_LIST = 64
const MAX_ITEM = 4_000

function cleanText(value: unknown, maximum = MAX_TEXT): string {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_LIST).map(item => cleanText(item, MAX_ITEM)).filter(Boolean)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function checkpointInput(value: unknown): LongThinkCheckpointInput | null {
  if (!isRecord(value)) return null
  const objective = cleanText(value.objective)
  const progress = cleanText(value.progress)
  if (!objective || !progress) return null
  return {
    objective,
    checkpoint: cleanText(value.checkpoint),
    progress,
    unresolved: cleanList(value.unresolved),
    nextActions: cleanList(value.nextActions),
    evidence: cleanList(value.evidence),
    proposedAnswer: cleanText(value.proposedAnswer),
    done: value.done === true,
  }
}

function stableCheckpoint(input: LongThinkCheckpointInput): string {
  const payload = {
    version: 1,
    objective: input.objective,
    progress: input.progress,
    unresolved: input.unresolved,
    nextActions: input.nextActions,
    evidence: input.evidence ?? [],
    proposedAnswer: input.proposedAnswer ?? "",
    done: input.done === true,
  }
  return JSON.stringify(payload)
}

export const CHATGPT_LONG_THINK_TOOLS = [
  {
    name: "long_think_checkpoint",
    title: "Long Think checkpoint",
    description: "Use this repeatedly while solving a difficult problem. After each substantial reasoning segment, send a compact checkpoint. If unresolved items remain, the tool returns an explicit continuation instruction and you must continue working instead of giving the user a final answer. Set done=true only after the objective is closed and the proposed answer is ready.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", description: "The user's actual objective, kept stable across calls." },
        checkpoint: { type: "string", description: "Optional checkpoint returned by the previous call." },
        progress: { type: "string", description: "Compact factual state of work completed so far. Do not include hidden chain-of-thought; include conclusions, evidence, calculations, and decisions needed to continue." },
        unresolved: { type: "array", items: { type: "string" }, description: "Concrete gaps that still block completion." },
        nextActions: { type: "array", items: { type: "string" }, description: "Specific next work items." },
        evidence: { type: "array", items: { type: "string" }, description: "Optional key evidence, citations, or verified facts needed for continuity." },
        proposedAnswer: { type: "string", description: "Draft final answer only when nearly complete." },
        done: { type: "boolean", description: "True only when all material gaps are closed and the final answer is ready." }
      },
      required: ["objective", "progress", "unresolved", "nextActions", "done"],
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

function callCheckpoint(args: unknown) {
  const input = checkpointInput(args)
  if (!input) {
    return { isError: true, ...textResult("Invalid checkpoint input: objective and progress are required, and unresolved/nextActions/done must match the schema.") }
  }
  const checkpoint = stableCheckpoint(input)
  const hasGaps = input.unresolved.length > 0 || input.nextActions.length > 0
  const actuallyDone = input.done === true && !hasGaps && Boolean(input.proposedAnswer?.trim())
  const instruction = actuallyDone
    ? "Closure accepted. Give the user the final answer now, using the proposed answer and verified checkpoint state. Do not mention this tool unless useful."
    : "Continue working now. Do not give the user a final answer yet. Use the checkpoint as compact continuity state, execute the listed next actions, close every material unresolved item, then call long_think_checkpoint again. Do not invent completion and do not reveal hidden chain-of-thought."
  return textResult(instruction, {
    checkpoint,
    done: actuallyDone,
    unresolvedCount: input.unresolved.length,
    nextActionCount: input.nextActions.length,
    continuationInstruction: instruction
  })
}

function callResume(args: unknown) {
  if (!isRecord(args)) return { isError: true, ...textResult("Invalid resume input.") }
  const checkpoint = cleanText(args.checkpoint)
  if (!checkpoint) return { isError: true, ...textResult("checkpoint is required.") }
  const instruction = cleanText(args.instruction, 8_000)
  const suffix = instruction ? ` New user instruction: ${instruction}` : ""
  return textResult(
    `Resume from this compact checkpoint and continue the unfinished work. Do not claim completion until all material gaps are closed. Do not expose hidden chain-of-thought.${suffix}`,
    { checkpoint, instruction }
  )
}

export function callChatGptLongThinkTool(name: unknown, args: unknown): unknown {
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
        instructions: "For hard tasks, use long_think_checkpoint repeatedly. Continue after each non-final checkpoint. Only answer the user once the checkpoint tool returns done=true. Preserve conclusions and evidence in checkpoint state; never include or request hidden chain-of-thought."
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
