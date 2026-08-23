import { createAdminClient } from "@/lib/supabase/admin"
import {
  applyMaestroReport,
  createMaestroTask,
  findMaestroTaskByStartCode,
  maestroMeta,
  markMaestroRoundStarted,
  publicMaestroTask,
  type AgentTaskRow,
  type MaestroAction,
  type MaestroPhase,
  type MaestroReportState,
  type MaestroRoundRecord,
} from "@/lib/maestro/store"
import { MAESTRO_WIDGET_HTML, MAESTRO_WIDGET_URI } from "@/lib/maestro/widget"

export const MAESTRO_PROTOCOL_VERSION = "2025-06-18"
export const MAESTRO_SERVER_NAME = "mychat-maestro-runner"
export const MAESTRO_SERVER_VERSION = "1.2.1"

const MAX_CHECKPOINT = 36_000
const MAX_ANSWER = 120_000
const MAX_ROUND_OUTPUT = 120_000
const MAX_LIST = 64
const MAX_ITEM = 4_000
const MAX_OBJECTIVE = 100_000
const DEFAULT_MAX_ROUNDS = 10_000

type JsonRpcId = string | number | null
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown }
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } }

type CreateInput = { objective: string; maxRounds: number }
type GateInput = {
  startCode: string
  round: number
  phase: Exclude<MaestroPhase, "done">
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  roundOutput: string
  finalAnswer: string
  done: boolean
}
type StartRoundInput = { startCode: string; round: number }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function cleanText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_LIST).map(item => cleanText(item, MAX_ITEM)).filter(Boolean)
}

function createInput(value: unknown): CreateInput | null {
  const row = record(value)
  if (!row) return null
  const objective = cleanText(row.objective, MAX_OBJECTIVE)
  const maxRounds = row.maxRounds === undefined ? DEFAULT_MAX_ROUNDS : Number(row.maxRounds)
  if (!objective || !Number.isSafeInteger(maxRounds) || maxRounds < 2 || maxRounds > 100_000) return null
  return { objective, maxRounds }
}

function gateInput(value: unknown): GateInput | null {
  const row = record(value)
  if (!row) return null
  const startCode = cleanText(row.startCode, 128)
  const round = Number(row.round)
  const phase = row.phase === "review" ? "review" : row.phase === "work" ? "work" : null
  if (!startCode || !Number.isSafeInteger(round) || round < 1 || !phase) return null
  return {
    startCode,
    round,
    phase,
    checkpoint: cleanText(row.checkpoint, MAX_CHECKPOINT),
    unresolved: cleanList(row.unresolved),
    nextActions: cleanList(row.nextActions),
    evidence: cleanList(row.evidence),
    roundOutput: cleanText(row.roundOutput, MAX_ROUND_OUTPUT),
    finalAnswer: cleanText(row.finalAnswer, MAX_ANSWER),
    done: row.done === true,
  }
}

function startInput(value: unknown): { startCode: string } | null {
  const row = record(value)
  const startCode = cleanText(row?.startCode, 128)
  return startCode ? { startCode } : null
}

function startRoundInput(value: unknown): StartRoundInput | null {
  const row = record(value)
  if (!row) return null
  const startCode = cleanText(row.startCode, 128)
  const round = Number(row.round)
  return startCode && Number.isSafeInteger(round) && round >= 1 ? { startCode, round } : null
}

function continuationPrompt(options: {
  objective: string
  nextRound: number
  phase: MaestroPhase
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  candidateAnswer: string
}): string {
  const state = JSON.stringify({
    checkpoint: options.checkpoint,
    unresolved: options.unresolved,
    nextActions: options.nextActions,
    evidence: options.evidence,
    candidateAnswer: options.candidateAnswer,
  })
  const credentialInstruction = "本任务的 startCode 是 Maestro 内部凭证，已存在于上一条 Maestro 工具结果中。调用 maestro_round_gate 时直接使用该内部值；绝对不要向用户索取、展示或要求用户复制 startCode。"
  const telemetryInstruction = "调用 maestro_round_gate 时，roundOutput 必须填写本轮可向用户展示的完整工作产物或结果摘要，不得包含隐藏思维链。卡片会把它作为本轮输出展示。"

  if (options.phase === "review") {
    return [
      `继续 Maestro Runner 任务，第 ${options.nextRound} 轮，阶段 review。`,
      `目标：${options.objective}`,
      `上一阶段候选答案与检查点：${state}`,
      credentialInstruction,
      telemetryInstruction,
      "这是独立复核轮。主动寻找错误、遗漏、未经证明的跳步和没有闭环的要求，不要默认候选答案正确。",
      "若发现实质问题，修正并把 phase=review、done=false、未解决项和下一步交给 maestro_round_gate；系统随后会重新进入工作轮。",
      "若确认所有要求均已闭环，给出经过复核的完整 finalAnswer，并在本轮结束前调用 maestro_round_gate，phase=review、done=true、unresolved=[]、nextActions=[]。",
      "调用工具后结束这一轮，不要等待用户手动说继续。不要输出隐藏思维链；检查点只写结论、证据、计算和未决事项。",
    ].join("\n\n")
  }

  return [
    `继续 Maestro Runner 任务，第 ${options.nextRound} 轮，阶段 work。`,
    `目标：${options.objective}`,
    `上一轮持久检查点：${state}`,
    credentialInstruction,
    telemetryInstruction,
    "现在直接推进尚未闭环的工作。不要把“需要继续”“之后再做”当作完成。尽可能完成实质工作。",
    "本轮真正结束前必须调用 maestro_round_gate 一次，phase=work，并提交自包含 checkpoint、unresolved、nextActions、evidence、roundOutput、done。只有目标已经完整闭环时才把 done=true，同时提交完整 finalAnswer。",
    "调用工具后结束这一轮。工具界面会自动创建下一轮，不需要用户手动发送“继续”。不要输出隐藏思维链；检查点只写继续工作必需的结论、证据、计算和未决事项。",
  ].join("\n\n")
}

function nextPromptForTask(row: AgentTaskRow): string {
  const task = publicMaestroTask(row)
  if (!task) throw new Error("Maestro task metadata is invalid")
  if (task.status === "completed" || task.status === "cancelled" || task.status === "failed" || task.phase === "done") return ""
  return continuationPrompt({
    objective: task.objective,
    nextRound: task.round + 1,
    phase: task.phase,
    checkpoint: task.checkpoint,
    unresolved: task.unresolved,
    nextActions: task.nextActions,
    evidence: task.evidence,
    candidateAnswer: task.candidateAnswer,
  })
}

function storedState(row: AgentTaskRow): MaestroReportState {
  const task = publicMaestroTask(row)
  if (!task) throw new Error("Maestro task metadata is invalid")
  const stopped = task.status === "cancelled" || task.status === "failed"
  const completed = task.status === "completed" && Boolean(task.finalAnswer)
  const phase: MaestroPhase = completed ? "done" : task.phase
  const action: MaestroAction = completed ? "finish" : stopped ? "stop" : phase === "review" ? "review" : "continue"
  const nextPrompt = action === "finish" || action === "stop" ? "" : nextPromptForTask(row)
  return {
    kind: "maestro-runner-state",
    jobId: task.id,
    startCode: task.startCode,
    objective: task.objective,
    status: task.status,
    round: task.round,
    phase,
    action,
    checkpoint: task.checkpoint,
    unresolved: task.unresolved,
    nextActions: task.nextActions,
    evidence: task.evidence,
    candidateAnswer: task.candidateAnswer,
    finalAnswer: task.finalAnswer,
    nextPrompt,
    currentInput: task.currentInput || nextPrompt,
    currentRoundStartedAt: task.currentRoundStartedAt,
    totalElapsedMs: task.totalElapsedMs,
    lastOutput: task.lastOutput,
    history: task.history,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    launchGranted: false,
  }
}

export function evaluateMaestroGate(row: AgentTaskRow, input: GateInput): MaestroReportState {
  const task = publicMaestroTask(row)
  const meta = maestroMeta(row)
  if (!task || !meta) throw new Error("Maestro task metadata is invalid")
  if (task.status === "cancelled" || task.status === "failed" || task.status === "completed") return storedState(row)
  if (input.round <= meta.round) return storedState(row)
  if (input.round !== meta.round + 1) throw new Error(`Expected Maestro round ${meta.round + 1}`)
  if (input.round > meta.maxRounds) throw new Error(`Maestro max rounds reached (${meta.maxRounds})`)

  const expectedPhase: MaestroPhase = meta.phase === "review" ? "review" : "work"
  const hasGaps = input.unresolved.length > 0 || input.nextActions.length > 0
  const closure = input.done && !hasGaps && Boolean(input.finalAnswer)

  let phase: MaestroPhase
  let action: MaestroAction
  let candidateAnswer = meta.candidateAnswer
  let finalAnswer = ""

  if (expectedPhase === "work" && closure) {
    phase = "review"
    action = "review"
    candidateAnswer = input.finalAnswer
  } else if (expectedPhase === "review" && closure) {
    phase = "done"
    action = "finish"
    finalAnswer = input.finalAnswer
    candidateAnswer = meta.candidateAnswer || input.finalAnswer
  } else {
    phase = "work"
    action = "continue"
  }

  const nextPrompt = action === "continue" || action === "review" ? continuationPrompt({
    objective: task.objective,
    nextRound: input.round + 1,
    phase,
    checkpoint: input.checkpoint,
    unresolved: input.unresolved,
    nextActions: input.nextActions,
    evidence: input.evidence,
    candidateAnswer,
  }) : ""

  return {
    kind: "maestro-runner-state",
    jobId: task.id,
    startCode: task.startCode,
    objective: task.objective,
    status: action === "finish" ? "completed" : "running",
    round: input.round,
    phase,
    action,
    checkpoint: input.checkpoint,
    unresolved: input.unresolved,
    nextActions: input.nextActions,
    evidence: input.evidence,
    candidateAnswer,
    finalAnswer,
    nextPrompt,
    currentInput: nextPrompt,
    currentRoundStartedAt: null,
    totalElapsedMs: meta.totalElapsedMs,
    lastOutput: meta.lastOutput,
    history: meta.history,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    launchGranted: false,
  }
}

function roundSchema() {
  return {
    type: "object",
    properties: {
      round: { type: "integer", minimum: 1 },
      phase: { type: "string", enum: ["work", "review"] },
      input: { type: "string" },
      output: { type: "string" },
      checkpoint: { type: "string" },
      action: { type: "string", enum: ["continue", "review", "finish", "stop"] },
      startedAt: { type: "string" },
      finishedAt: { type: "string" },
      elapsedMs: { type: "integer", minimum: 0 },
    },
    required: ["round", "phase", "input", "output", "checkpoint", "action", "startedAt", "finishedAt", "elapsedMs"],
    additionalProperties: false,
  }
}

function stateOutputSchema() {
  return {
    type: "object",
    properties: {
      kind: { type: "string", const: "maestro-runner-state" },
      jobId: { type: "string" },
      startCode: { type: "string", description: "Internal Maestro task capability. Never ask the user for it or display it to the user." },
      objective: { type: "string" },
      status: { type: "string" },
      round: { type: "integer", minimum: 0 },
      phase: { type: "string", enum: ["work", "review", "done"] },
      action: { type: "string", enum: ["continue", "review", "finish", "stop"] },
      checkpoint: { type: "string" },
      unresolved: { type: "array", items: { type: "string" } },
      nextActions: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } },
      candidateAnswer: { type: "string" },
      finalAnswer: { type: "string" },
      nextPrompt: { type: "string" },
      currentInput: { type: "string" },
      currentRoundStartedAt: { type: ["string", "null"] },
      totalElapsedMs: { type: "integer", minimum: 0 },
      lastOutput: { type: "string" },
      history: { type: "array", items: roundSchema(), maxItems: 100 },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
      launchGranted: { type: "boolean" },
    },
    required: ["kind", "jobId", "startCode", "objective", "status", "round", "phase", "action", "checkpoint", "unresolved", "nextActions", "evidence", "candidateAnswer", "finalAnswer", "nextPrompt", "currentInput", "currentRoundStartedAt", "totalElapsedMs", "lastOutput", "history", "createdAt", "updatedAt", "launchGranted"],
    additionalProperties: false,
  }
}

const WIDGET_ACCESSIBLE = { "openai/widgetAccessible": true } as const

export const MAESTRO_TOOLS = [
  {
    name: "maestro_create_task",
    title: "Run a new Maestro task",
    description: "Create and immediately start a new Maestro Runner task from the user's objective. A fresh unique startCode is generated internally for every task and is carried by Maestro tool state. For a new task, use this tool directly and NEVER ask the user to generate, find, copy, paste, or provide a start code.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", minLength: 1, maxLength: MAX_OBJECTIVE, description: "Complete objective for the multi-turn task." },
        maxRounds: { type: "integer", minimum: 2, maximum: 100_000, default: DEFAULT_MAX_ROUNDS },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: {
      ...WIDGET_ACCESSIBLE,
      ui: { resourceUri: MAESTRO_WIDGET_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": MAESTRO_WIDGET_URI,
      "openai/toolInvocation/invoking": "Starting Maestro task…",
      "openai/toolInvocation/invoked": "Maestro task started",
    },
  },
  {
    name: "maestro_start",
    title: "Resume Maestro task by code",
    description: "Legacy recovery path for an EXISTING Maestro task when a start code has already been explicitly supplied. Never ask a user for a start code. For every new task call maestro_create_task instead.",
    inputSchema: { type: "object", properties: { startCode: { type: "string", minLength: 12, maxLength: 128 } }, required: ["startCode"], additionalProperties: false },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      ...WIDGET_ACCESSIBLE,
      ui: { resourceUri: MAESTRO_WIDGET_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": MAESTRO_WIDGET_URI,
      "openai/toolInvocation/invoking": "Loading Maestro task…",
      "openai/toolInvocation/invoked": "Maestro task loaded",
    },
  },
  {
    name: "maestro_round_gate",
    title: "Maestro round gate",
    description: "Persist and evaluate the checkpoint at the end of every Maestro worker or review turn. Use the internal startCode from the most recent Maestro tool state; never ask the user for it and never display it. Include roundOutput as the complete user-visible work product or result summary for this round, excluding hidden chain-of-thought. The tool decides continue/review/finish and persists all telemetry before returning.",
    inputSchema: {
      type: "object",
      properties: {
        startCode: { type: "string", minLength: 12, maxLength: 128, description: "Internal value from Maestro tool state. Never obtain this from the user." },
        round: { type: "integer", minimum: 1, maximum: 1000000 },
        phase: { type: "string", enum: ["work", "review"] },
        checkpoint: { type: "string", description: "Self-contained continuation state: conclusions, evidence, calculations, decisions and current progress. Never include hidden chain-of-thought." },
        unresolved: { type: "array", items: { type: "string" }, maxItems: MAX_LIST },
        nextActions: { type: "array", items: { type: "string" }, maxItems: MAX_LIST },
        evidence: { type: "array", items: { type: "string" }, maxItems: MAX_LIST },
        roundOutput: { type: "string", description: "User-visible work product or result summary produced in this round. Never include hidden chain-of-thought." },
        finalAnswer: { type: "string", description: "Complete candidate/final answer only when done=true; otherwise use an empty string." },
        done: { type: "boolean" },
      },
      required: ["startCode", "round", "phase", "checkpoint", "unresolved", "nextActions", "evidence", "roundOutput", "finalAnswer", "done"],
      additionalProperties: false,
    },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: {
      ...WIDGET_ACCESSIBLE,
      ui: { resourceUri: MAESTRO_WIDGET_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": MAESTRO_WIDGET_URI,
      "openai/toolInvocation/invoking": "Saving Maestro round…",
      "openai/toolInvocation/invoked": "Maestro round saved",
    },
  },
  {
    name: "maestro_status",
    title: "Read Maestro live status",
    description: "Widget-only read of authoritative Maestro task state and telemetry using the internal startCode.",
    inputSchema: { type: "object", properties: { startCode: { type: "string", minLength: 12, maxLength: 128 } }, required: ["startCode"], additionalProperties: false },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...WIDGET_ACCESSIBLE, ui: { visibility: ["app"] } },
  },
  {
    name: "maestro_round_started",
    title: "Mark Maestro round started",
    description: "Widget-only internal telemetry marker. Records the exact wall-clock start of the next Maestro round and its input prompt. Exactly one widget receives launchGranted=true and may post the next follow-up turn.",
    inputSchema: {
      type: "object",
      properties: {
        startCode: { type: "string", minLength: 12, maxLength: 128 },
        round: { type: "integer", minimum: 1, maximum: 1000000 },
      },
      required: ["startCode", "round"],
      additionalProperties: false,
    },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...WIDGET_ACCESSIBLE, ui: { visibility: ["app"] } },
  },
] as const

function textResult(state: MaestroReportState) {
  return {
    structuredContent: state,
    content: [{ type: "text", text: state.action === "finish"
      ? "Maestro independent review accepted closure. The runner will stop."
      : state.action === "stop"
        ? "Maestro task is stopped."
        : state.action === "review"
          ? "Candidate answer reached closure criteria. The Maestro UI will automatically start a separate review turn."
          : "Maestro state is ready. The UI will automatically start or track the next ChatGPT turn." }],
    _meta: { jobId: state.jobId },
  }
}

async function resolveMaestroOwnerUserId(): Promise<string> {
  const configured = process.env.MAESTRO_OWNER_USER_ID?.trim()
  if (configured) return configured
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const recent = await admin.from("agent_tasks").select("user_id").order("created_at", { ascending: false }).limit(100)
  if (recent.error) throw new Error(recent.error.message)
  const userIds = new Set((recent.data ?? []).map(row => row.user_id).filter(Boolean))
  if (userIds.size === 1) return [...userIds][0]
  if (userIds.size > 1) throw new Error("MAESTRO_OWNER_USER_ID must be configured when more than one My Chat user exists")
  const users = await admin.auth.admin.listUsers({ page: 1, perPage: 2 })
  if (users.error) throw new Error(users.error.message)
  if (users.data.users.length === 1) return users.data.users[0].id
  throw new Error("Unable to resolve Maestro owner; configure MAESTRO_OWNER_USER_ID")
}

async function callCreate(args: unknown) {
  const input = createInput(args)
  if (!input) throw new Error("objective is required and maxRounds must be an integer from 2 to 100000")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const userId = await resolveMaestroOwnerUserId()
  const row = await createMaestroTask(admin, userId, input.objective, input.maxRounds)
  return textResult(storedState(row))
}

async function callStart(args: unknown) {
  const input = startInput(args)
  if (!input) throw new Error("startCode is required")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await findMaestroTaskByStartCode(admin, input.startCode)
  if (!row) throw new Error("Maestro start code not found")
  return textResult(storedState(row))
}

async function callStatus(args: unknown) {
  const input = startInput(args)
  if (!input) throw new Error("startCode is required")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await findMaestroTaskByStartCode(admin, input.startCode)
  if (!row) throw new Error("Maestro start code not found")
  return textResult(storedState(row))
}

async function callRoundStarted(args: unknown) {
  const input = startRoundInput(args)
  if (!input) throw new Error("Invalid Maestro round start")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await findMaestroTaskByStartCode(admin, input.startCode)
  if (!row) throw new Error("Maestro start code not found")
  const pending = storedState(row)
  const claimed = await markMaestroRoundStarted(admin, row.user_id, row.id, input.round, pending.currentInput || pending.nextPrompt)
  const state = storedState(claimed.row)
  state.launchGranted = claimed.started
  return textResult(state)
}

function elapsedMs(startedAt: string | null, fallback: string): number {
  const start = Date.parse(startedAt || fallback)
  return Number.isFinite(start) ? Math.max(0, Date.now() - start) : 0
}

async function callGate(args: unknown) {
  const input = gateInput(args)
  if (!input) throw new Error("Invalid Maestro round checkpoint")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await findMaestroTaskByStartCode(admin, input.startCode)
  if (!row) throw new Error("Maestro start code not found")
  const meta = maestroMeta(row)
  if (!meta) throw new Error("Maestro task metadata is invalid")
  if (input.round <= meta.round) return textResult(storedState(row))

  const prior = storedState(row)
  const state = evaluateMaestroGate(row, input)
  const now = new Date().toISOString()
  const roundElapsed = elapsedMs(meta.currentRoundStartedAt, row.updated_at || row.created_at)
  const roundRecord: MaestroRoundRecord = {
    round: input.round,
    phase: input.phase,
    input: meta.currentInput || prior.currentInput || prior.nextPrompt,
    output: input.roundOutput || input.checkpoint,
    checkpoint: input.checkpoint,
    action: state.action,
    startedAt: meta.currentRoundStartedAt || row.updated_at || row.created_at,
    finishedAt: now,
    elapsedMs: roundElapsed,
  }
  state.history = [...meta.history.filter(item => item.round < input.round), roundRecord].slice(-100)
  state.totalElapsedMs = meta.totalElapsedMs + roundElapsed
  state.lastOutput = roundRecord.output
  state.currentInput = state.nextPrompt
  state.currentRoundStartedAt = null
  state.updatedAt = now
  state.launchGranted = false

  await applyMaestroReport(admin, row.user_id, row.id, state)
  return textResult(state)
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function resource() {
  return {
    uri: MAESTRO_WIDGET_URI,
    mimeType: "text/html;profile=mcp-app",
    text: MAESTRO_WIDGET_HTML,
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetDescription": "Live Maestro Runner dashboard with synchronized round, visible input/output, phase, and elapsed runtime. Internal task codes are never user input.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    },
  }
}

export async function handleMaestroRpc(body: JsonRpcRequest, _options: { origin: string }): Promise<JsonRpcResponse | null> {
  const id = body.id ?? null
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(id, -32600, "Invalid Request")
  if (body.method.startsWith("notifications/")) return null
  if (body.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MAESTRO_PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: MAESTRO_SERVER_NAME, version: MAESTRO_SERVER_VERSION },
        instructions: "For every NEW user request that should run through Maestro, call maestro_create_task with the objective. It creates a fresh unique internal startCode and starts the runner immediately. Never ask the user for a start code and never display one. maestro_start exists only to recover an old task when the code was already supplied. Every active worker/review turn must end with maestro_round_gate using the internal startCode from Maestro tool state and must include roundOutput containing the user-visible work product. The gate persists checkpoint, phase, visible input/output, round timing, total elapsed runtime, and history before returning. The widget uses widget-only maestro_status and maestro_round_started calls to keep one card synchronized without cross-origin fetches; exactly one card is granted permission to launch each next turn.",
      },
    }
  }
  if (body.method === "ping") return { jsonrpc: "2.0", id, result: {} }
  if (body.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: MAESTRO_TOOLS } }
  if (body.method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [{ uri: MAESTRO_WIDGET_URI, name: "Maestro Runner", mimeType: "text/html;profile=mcp-app" }] } }
  if (body.method === "resources/templates/list") return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } }
  if (body.method === "resources/read") {
    const params = record(body.params)
    if (params?.uri !== MAESTRO_WIDGET_URI) return rpcError(id, -32002, "Resource not found")
    return { jsonrpc: "2.0", id, result: { contents: [resource()] } }
  }
  if (body.method === "tools/call") {
    const params = record(body.params)
    const name = params?.name
    try {
      if (name === "maestro_create_task") return { jsonrpc: "2.0", id, result: await callCreate(params?.arguments) }
      if (name === "maestro_start") return { jsonrpc: "2.0", id, result: await callStart(params?.arguments) }
      if (name === "maestro_round_gate") return { jsonrpc: "2.0", id, result: await callGate(params?.arguments) }
      if (name === "maestro_status") return { jsonrpc: "2.0", id, result: await callStatus(params?.arguments) }
      if (name === "maestro_round_started") return { jsonrpc: "2.0", id, result: await callRoundStarted(params?.arguments) }
      return rpcError(id, -32602, "Unknown Maestro tool")
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Maestro tool failed" }] } }
    }
  }
  return rpcError(id, -32601, "Method not found")
}
