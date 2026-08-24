import { createAdminClient } from "@/lib/supabase/admin"
import {
  applyMaestroReport,
  createMaestroTask,
  getMaestroTask,
  maestroMeta,
  markMaestroRoundStarted,
  publicMaestroTask,
  type AgentTaskRow,
  type MaestroAction,
  type MaestroPhase,
  type MaestroReportState,
  type MaestroRoundRecord,
} from "@/lib/maestro/store"
import { issueMaestroTaskToken, verifyMaestroTaskToken } from "@/lib/maestro/tokens"
import { MAESTRO_WIDGET_HTML, MAESTRO_WIDGET_URI } from "@/lib/maestro/widget"

export const MAESTRO_PROTOCOL_VERSION = "2025-06-18"
export const MAESTRO_SERVER_NAME = "mychat-maestro-runner-v2"
export const MAESTRO_SERVER_VERSION = "2.0.0"

const MAX_CHECKPOINT = 36_000
const MAX_ANSWER = 120_000
const MAX_ROUND_OUTPUT = 120_000
const MAX_LIST = 64
const MAX_ITEM = 4_000
const MAX_OBJECTIVE = 100_000
const MAX_TOKEN = 4_096
const DEFAULT_MAX_ROUNDS = 10_000

type JsonRpcId = string | number | null
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown }
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } }
type CreateInput = { objective: string; maxRounds: number }
type GateInput = {
  taskToken: string
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
type GateEvaluationInput = Omit<GateInput, "taskToken" | "roundOutput">

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
  return objective && Number.isSafeInteger(maxRounds) && maxRounds >= 2 && maxRounds <= 100_000 ? { objective, maxRounds } : null
}

function startInput(value: unknown): { taskToken: string } {
  const row = record(value)
  return { taskToken: cleanText(row?.taskToken, MAX_TOKEN) }
}

function gateInput(value: unknown): GateInput | null {
  const row = record(value)
  if (!row) return null
  const taskToken = cleanText(row.taskToken, MAX_TOKEN)
  const round = Number(row.round)
  const phase = row.phase === "review" ? "review" : row.phase === "work" ? "work" : null
  if (!taskToken || !Number.isSafeInteger(round) || round < 1 || !phase) return null
  return {
    taskToken,
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
  const state = JSON.stringify({ checkpoint: options.checkpoint, unresolved: options.unresolved, nextActions: options.nextActions, evidence: options.evidence, candidateAnswer: options.candidateAnswer })
  const telemetry = "调用 maestro_round_gate 时，roundOutput 必须填写本轮可向用户展示的完整工作产物或结果摘要，不得包含隐藏思维链。"
  if (options.phase === "review") {
    return [
      `继续 Maestro Runner 任务，第 ${options.nextRound} 轮，阶段 review。`,
      `目标：${options.objective}`,
      `上一阶段候选答案与检查点：${state}`,
      telemetry,
      "这是独立复核轮。主动寻找错误、遗漏、未经证明的跳步和没有闭环的要求，不要默认候选答案正确。",
      "若发现实质问题，修正并把 phase=review、done=false、未解决项和下一步交给 maestro_round_gate；系统随后会重新进入工作轮。",
      "若确认所有要求均已闭环，给出经过复核的完整 finalAnswer，并在本轮结束前调用 maestro_round_gate，phase=review、done=true、unresolved=[]、nextActions=[]。",
      "调用工具后结束这一轮，不要等待用户手动说继续。不要输出隐藏思维链。",
    ].join("\n\n")
  }
  return [
    `继续 Maestro Runner 任务，第 ${options.nextRound} 轮，阶段 work。`,
    `目标：${options.objective}`,
    `上一轮持久检查点：${state}`,
    telemetry,
    "现在直接推进尚未闭环的工作。不要把‘需要继续’‘之后再做’当作完成。尽可能完成实质工作。",
    "本轮真正结束前必须调用 maestro_round_gate 一次，phase=work，并提交自包含 checkpoint、unresolved、nextActions、evidence、roundOutput、done。只有目标已经完整闭环时才把 done=true，同时提交完整 finalAnswer。",
    "调用工具后结束这一轮。工具界面会自动创建下一轮，不需要用户手动发送‘继续’。不要输出隐藏思维链。",
  ].join("\n\n")
}

function nextPromptForTask(row: AgentTaskRow): string {
  const task = publicMaestroTask(row)
  if (!task) throw new Error("Maestro task metadata is invalid")
  if (task.status === "completed" || task.status === "cancelled" || task.status === "failed" || task.phase === "done") return ""
  return continuationPrompt({ objective: task.objective, nextRound: task.round + 1, phase: task.phase, checkpoint: task.checkpoint, unresolved: task.unresolved, nextActions: task.nextActions, evidence: task.evidence, candidateAnswer: task.candidateAnswer })
}

function storedState(row: AgentTaskRow, taskToken: string): MaestroReportState {
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
    taskToken,
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

export function evaluateMaestroGate(row: AgentTaskRow, input: GateEvaluationInput, taskToken: string): MaestroReportState {
  const task = publicMaestroTask(row)
  const meta = maestroMeta(row)
  if (!task || !meta) throw new Error("Maestro task metadata is invalid")
  if (task.status === "cancelled" || task.status === "failed" || task.status === "completed") return storedState(row, taskToken)
  if (input.round <= meta.round) return storedState(row, taskToken)
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
    phase = "review"; action = "review"; candidateAnswer = input.finalAnswer
  } else if (expectedPhase === "review" && closure) {
    phase = "done"; action = "finish"; finalAnswer = input.finalAnswer; candidateAnswer = meta.candidateAnswer || input.finalAnswer
  } else {
    phase = "work"; action = "continue"
  }
  const nextPrompt = action === "continue" || action === "review" ? continuationPrompt({ objective: task.objective, nextRound: input.round + 1, phase, checkpoint: input.checkpoint, unresolved: input.unresolved, nextActions: input.nextActions, evidence: input.evidence, candidateAnswer }) : ""
  return {
    kind: "maestro-runner-state",
    jobId: task.id,
    taskToken,
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
  return { type: "object", properties: { round: { type: "integer", minimum: 1 }, phase: { type: "string", enum: ["work", "review"] }, input: { type: "string" }, output: { type: "string" }, checkpoint: { type: "string" }, action: { type: "string", enum: ["continue", "review", "finish", "stop"] }, startedAt: { type: "string" }, finishedAt: { type: "string" }, elapsedMs: { type: "integer", minimum: 0 } }, required: ["round", "phase", "input", "output", "checkpoint", "action", "startedAt", "finishedAt", "elapsedMs"], additionalProperties: false }
}

function stateOutputSchema() {
  return {
    type: "object",
    properties: {
      kind: { type: "string", const: "maestro-runner-state" },
      jobId: { type: "string" },
      taskToken: { type: "string", description: "Internal Maestro capability. Never request or display it to the user." },
      objective: { type: "string" }, status: { type: "string" }, round: { type: "integer", minimum: 0 }, phase: { type: "string", enum: ["work", "review", "done"] }, action: { type: "string", enum: ["continue", "review", "finish", "stop"] }, checkpoint: { type: "string" }, unresolved: { type: "array", items: { type: "string" } }, nextActions: { type: "array", items: { type: "string" } }, evidence: { type: "array", items: { type: "string" } }, candidateAnswer: { type: "string" }, finalAnswer: { type: "string" }, nextPrompt: { type: "string" }, currentInput: { type: "string" }, currentRoundStartedAt: { type: ["string", "null"] }, totalElapsedMs: { type: "integer", minimum: 0 }, lastOutput: { type: "string" }, history: { type: "array", items: roundSchema(), maxItems: 100 }, createdAt: { type: "string" }, updatedAt: { type: "string" }, launchGranted: { type: "boolean" },
    },
    required: ["kind", "jobId", "taskToken", "objective", "status", "round", "phase", "action", "checkpoint", "unresolved", "nextActions", "evidence", "candidateAnswer", "finalAnswer", "nextPrompt", "currentInput", "currentRoundStartedAt", "totalElapsedMs", "lastOutput", "history", "createdAt", "updatedAt", "launchGranted"],
    additionalProperties: false,
  }
}

const WIDGET_ACCESSIBLE = { "openai/widgetAccessible": true } as const
const SHARED_META = { ...WIDGET_ACCESSIBLE, ui: { resourceUri: MAESTRO_WIDGET_URI, visibility: ["model", "app"] }, "openai/outputTemplate": MAESTRO_WIDGET_URI } as const

export const MAESTRO_TOOLS = [
  {
    name: "maestro_create_task", title: "Run a new Maestro task",
    description: "Create and immediately start a new Maestro Runner task from the user's objective. Always use this for @My che che. followed by a new task. Never ask the user for any code, token, task id, or relay value.",
    inputSchema: { type: "object", properties: { objective: { type: "string", minLength: 1, maxLength: MAX_OBJECTIVE }, maxRounds: { type: "integer", minimum: 2, maximum: 100_000, default: DEFAULT_MAX_ROUNDS } }, required: ["objective"], additionalProperties: false },
    outputSchema: stateOutputSchema(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: { ...SHARED_META, "openai/toolInvocation/invoking": "Starting Maestro task…", "openai/toolInvocation/invoked": "Maestro task started" },
  },
  {
    name: "maestro_start", title: "Start or synchronize the My Chat task",
    description: "For a fresh task launched from My Chat, call with no arguments and claim the newest queued task. The attached Maestro widget may later call this same tool with taskToken from internal tool state to synchronize and atomically claim the next round. Never ask the user for any code, token, task id, or relay value.",
    inputSchema: { type: "object", properties: { taskToken: { type: "string", minLength: 32, maxLength: MAX_TOKEN, description: "Optional widget-internal capability from prior Maestro state. Never obtain it from the user." } }, additionalProperties: false },
    outputSchema: stateOutputSchema(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...SHARED_META, "openai/toolInvocation/invoking": "Synchronizing Maestro…", "openai/toolInvocation/invoked": "Maestro synchronized" },
  },
  {
    name: "maestro_round_gate", title: "Maestro round gate",
    description: "Persist and evaluate the checkpoint at the end of every worker/review turn. Reuse taskToken from the latest internal Maestro state automatically. Never ask the user for relay values. Include roundOutput as the user-visible work product for this round.",
    inputSchema: { type: "object", properties: { taskToken: { type: "string", minLength: 32, maxLength: MAX_TOKEN }, round: { type: "integer", minimum: 1, maximum: 1_000_000 }, phase: { type: "string", enum: ["work", "review"] }, checkpoint: { type: "string" }, unresolved: { type: "array", items: { type: "string" }, maxItems: MAX_LIST }, nextActions: { type: "array", items: { type: "string" }, maxItems: MAX_LIST }, evidence: { type: "array", items: { type: "string" }, maxItems: MAX_LIST }, roundOutput: { type: "string" }, finalAnswer: { type: "string" }, done: { type: "boolean" } }, required: ["taskToken", "round", "phase", "checkpoint", "unresolved", "nextActions", "evidence", "roundOutput", "finalAnswer", "done"], additionalProperties: false },
    outputSchema: stateOutputSchema(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...SHARED_META, "openai/toolInvocation/invoking": "Saving Maestro round…", "openai/toolInvocation/invoked": "Maestro round saved" },
  },
] as const

function textResult(state: MaestroReportState) {
  return { structuredContent: state, content: [{ type: "text", text: state.action === "finish" ? "Maestro independent review accepted closure. The runner will stop." : state.action === "stop" ? "Maestro task is stopped." : state.action === "review" ? "Candidate answer reached closure criteria. The Maestro UI will start a separate review turn." : "Maestro state synchronized. The UI will start the next ChatGPT turn only when launchGranted is true." }], _meta: { jobId: state.jobId } }
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

async function latestQueuedTask(): Promise<{ row: AgentTaskRow; userId: string }> {
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const userId = await resolveMaestroOwnerUserId()
  const { data, error } = await admin.from("agent_tasks").select("id,user_id,goal,mode,repo,branch,status,error,created_at,updated_at,started_at,finished_at,meta,agent_branch,pull_request_url,pull_request_number,commit_sha").eq("user_id", userId).eq("branch", "maestro-runner-v1").eq("status", "queued").order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error("My Chat has no queued Maestro task to start")
  return { row: data as AgentTaskRow, userId }
}

async function taskFromCapability(taskToken: string): Promise<{ row: AgentTaskRow; token: string }> {
  const access = verifyMaestroTaskToken(taskToken)
  if (!access) throw new Error("Maestro task access expired; start the task again from My Chat")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await getMaestroTask(admin, access.userId, access.jobId)
  if (!row) throw new Error("Maestro task not found")
  return { row, token: issueMaestroTaskToken({ userId: access.userId, jobId: access.jobId }) }
}

async function claimNextRound(admin: NonNullable<ReturnType<typeof createAdminClient>>, row: AgentTaskRow, taskToken: string): Promise<MaestroReportState> {
  const pending = storedState(row, taskToken)
  if (!pending.nextPrompt || pending.status === "completed" || pending.status === "cancelled" || pending.status === "failed") return pending
  const claimed = await markMaestroRoundStarted(admin, row.user_id, row.id, pending.round + 1, pending.currentInput || pending.nextPrompt)
  const state = storedState(claimed.row, taskToken)
  state.launchGranted = claimed.started
  return state
}

async function callCreate(args: unknown) {
  const input = createInput(args)
  if (!input) throw new Error("objective is required and maxRounds must be an integer from 2 to 100000")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const userId = await resolveMaestroOwnerUserId()
  const row = await createMaestroTask(admin, userId, input.objective, input.maxRounds)
  const token = issueMaestroTaskToken({ userId, jobId: row.id })
  return textResult(await claimNextRound(admin, row, token))
}

async function callStart(args: unknown) {
  const input = startInput(args)
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  if (input.taskToken) {
    const resolved = await taskFromCapability(input.taskToken)
    return textResult(await claimNextRound(admin, resolved.row, resolved.token))
  }
  const { row, userId } = await latestQueuedTask()
  const token = issueMaestroTaskToken({ userId, jobId: row.id })
  return textResult(await claimNextRound(admin, row, token))
}

function elapsedMs(startedAt: string | null, fallback: string): number {
  const start = Date.parse(startedAt || fallback)
  return Number.isFinite(start) ? Math.max(0, Date.now() - start) : 0
}

async function callGate(args: unknown) {
  const input = gateInput(args)
  if (!input) throw new Error("Invalid Maestro round checkpoint")
  const access = verifyMaestroTaskToken(input.taskToken)
  if (!access) throw new Error("Invalid Maestro task capability")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await getMaestroTask(admin, access.userId, access.jobId)
  if (!row) throw new Error("Maestro task not found")
  const meta = maestroMeta(row)
  if (!meta) throw new Error("Maestro task metadata is invalid")
  const token = issueMaestroTaskToken({ userId: access.userId, jobId: access.jobId })
  if (input.round <= meta.round) return textResult(storedState(row, token))
  const prior = storedState(row, token)
  const state = evaluateMaestroGate(row, input, token)
  const now = new Date().toISOString()
  const roundElapsed = elapsedMs(meta.currentRoundStartedAt, row.updated_at || row.created_at)
  const roundRecord: MaestroRoundRecord = { round: input.round, phase: input.phase, input: meta.currentInput || prior.currentInput || prior.nextPrompt, output: input.roundOutput || input.checkpoint, checkpoint: input.checkpoint, action: state.action, startedAt: meta.currentRoundStartedAt || row.updated_at || row.created_at, finishedAt: now, elapsedMs: roundElapsed }
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
  return { uri: MAESTRO_WIDGET_URI, mimeType: "text/html;profile=mcp-app", text: MAESTRO_WIDGET_HTML, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, "openai/widgetDescription": "Live Maestro Runner dashboard with synchronized round, visible input/output, phase, and elapsed runtime.", "openai/widgetPrefersBorder": true, "openai/widgetCSP": { connect_domains: [], resource_domains: [] } } }
}

export async function handleMaestroRpc(body: JsonRpcRequest, _options: { origin: string }): Promise<JsonRpcResponse | null> {
  const id = body.id ?? null
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(id, -32600, "Invalid Request")
  if (body.method.startsWith("notifications/")) return null
  if (body.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: MAESTRO_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, serverInfo: { name: MAESTRO_SERVER_NAME, version: MAESTRO_SERVER_VERSION }, instructions: "For a new task inside ChatGPT call maestro_create_task. For a task launched from My Chat call maestro_start with no arguments. Never ask the user for any code, token, task id, or relay value. The Maestro widget reuses maestro_start with the internal task capability to synchronize and atomically claim later rounds. Every active worker/review turn must end with maestro_round_gate and include roundOutput. The gate persists checkpoint, phase, visible input/output, timing, total runtime, and history before returning." } }
  if (body.method === "ping") return { jsonrpc: "2.0", id, result: {} }
  if (body.method === "tools/list") {
    console.log(`[maestro-mcp] tools/list ${MAESTRO_SERVER_NAME}@${MAESTRO_SERVER_VERSION}: ${MAESTRO_TOOLS.map(tool => tool.name).join(",")}`)
    return { jsonrpc: "2.0", id, result: { tools: MAESTRO_TOOLS } }
  }
  if (body.method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [{ uri: MAESTRO_WIDGET_URI, name: "Maestro Runner", mimeType: "text/html;profile=mcp-app" }] } }
  if (body.method === "resources/templates/list") return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } }
  if (body.method === "resources/read") {
    const params = record(body.params)
    if (params?.uri !== MAESTRO_WIDGET_URI) return rpcError(id, -32002, "Resource not found")
    return { jsonrpc: "2.0", id, result: { contents: [resource()] } }
  }
  if (body.method === "tools/call") {
    const params = record(body.params)
    try {
      if (params?.name === "maestro_create_task") return { jsonrpc: "2.0", id, result: await callCreate(params.arguments) }
      if (params?.name === "maestro_start") return { jsonrpc: "2.0", id, result: await callStart(params.arguments) }
      if (params?.name === "maestro_round_gate") return { jsonrpc: "2.0", id, result: await callGate(params.arguments) }
      return rpcError(id, -32602, "Unknown Maestro tool")
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Maestro tool failed" }] } }
    }
  }
  return rpcError(id, -32601, "Method not found")
}
