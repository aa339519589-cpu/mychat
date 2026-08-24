import { createAdminClient } from "@/lib/supabase/admin"
import {
  applyMaestroReport,
  createMaestroTask,
  getMaestroTask,
  listMaestroTasks,
  maestroMeta,
  markMaestroRoundStarted,
  publicMaestroTask,
  type AgentTaskRow,
  type MaestroAction,
  type MaestroPhase,
  type MaestroReportState,
  type MaestroRoundRecord,
} from "@/lib/maestro/store"
import { maestroV4Prompt } from "@/lib/maestro/v4-prompts"
import { MAESTRO_V4_TOOLS, V4_MAX_LIST, V4_MAX_OBJECTIVE, V4_MAX_ROUND, V4_MAX_TOKEN } from "@/lib/maestro/v4-tools"
import { issueMaestroTaskToken, verifyMaestroTaskToken } from "@/lib/maestro/tokens"
import { MAESTRO_V4_WIDGET_HTML, MAESTRO_V4_WIDGET_URI } from "@/lib/maestro/widget-v4"

export { MAESTRO_V4_TOOLS } from "@/lib/maestro/v4-tools"
export const MAESTRO_V4_PROTOCOL_VERSION = "2025-06-18"
export const MAESTRO_V4_SERVER_NAME = "mychat-maestro-runner-v4-zero-code"
export const MAESTRO_V4_SERVER_VERSION = "4.0.0"

const MAX_CHECKPOINT = 36_000
const MAX_ANSWER = 120_000
const MAX_ROUND_OUTPUT = 120_000
const MAX_ITEM = 4_000
const DEFAULT_MAX_ROUNDS = 10_000

type JsonRpcId = string | number | null
type Rpc = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown }
export type MaestroV4RpcOptions = { origin: string; userId?: string | null }
type CreateInput = { objective: string; successCriterion: string; hardRules: string[]; maxRounds: number }
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
  criterionSatisfied: boolean
  reviewEvidence: string[]
}
type GateEvaluationInput = Omit<GateInput, "taskToken" | "roundOutput">

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function cleanText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, V4_MAX_LIST).map(item => cleanText(item, MAX_ITEM)).filter(Boolean)
}

function createInput(value: unknown): CreateInput | null {
  const row = record(value)
  if (!row) return null
  const objective = cleanText(row.objective, V4_MAX_OBJECTIVE)
  const successCriterion = cleanText(row.successCriterion, V4_MAX_OBJECTIVE) || objective
  const hardRules = cleanList(row.hardRules)
  const maxRounds = row.maxRounds === undefined ? DEFAULT_MAX_ROUNDS : Number(row.maxRounds)
  return objective && successCriterion && Number.isSafeInteger(maxRounds) && maxRounds >= 2 && maxRounds <= 100_000
    ? { objective, successCriterion, hardRules, maxRounds }
    : null
}

function syncInput(value: unknown): { taskToken: string } | null {
  const row = record(value)
  const taskToken = cleanText(row?.taskToken, V4_MAX_TOKEN)
  return taskToken ? { taskToken } : null
}

function gateInput(value: unknown): GateInput | null {
  const row = record(value)
  if (!row) return null
  const taskToken = cleanText(row.taskToken, V4_MAX_TOKEN)
  const round = Number(row.round)
  const phase = row.phase === "review" ? "review" : row.phase === "work" ? "work" : null
  if (!taskToken || !Number.isSafeInteger(round) || round < 1 || round > V4_MAX_ROUND || !phase) return null
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
    criterionSatisfied: row.criterionSatisfied === true,
    reviewEvidence: cleanList(row.reviewEvidence),
  }
}

function promptFor(row: AgentTaskRow): string {
  const task = publicMaestroTask(row)
  if (!task) throw new Error("Maestro task metadata is invalid")
  if (task.status === "completed" || task.status === "cancelled" || task.phase === "done") return ""
  return maestroV4Prompt({
    objective: task.objective,
    successCriterion: task.successCriterion,
    hardRules: task.hardRules,
    nextRound: task.round + 1,
    phase: task.phase,
    checkpoint: task.checkpoint,
    unresolved: task.unresolved,
    nextActions: task.nextActions,
    evidence: task.evidence,
    candidateAnswer: task.candidateAnswer,
  })
}

function storedState(row: AgentTaskRow, taskToken: string): MaestroReportState {
  const task = publicMaestroTask(row)
  if (!task) throw new Error("Maestro task metadata is invalid")
  const completed = task.status === "completed" && task.completionVerified && task.criterionSatisfied && Boolean(task.finalAnswer)
  const stopped = task.status === "cancelled"
  const phase: MaestroPhase = completed ? "done" : task.phase === "done" ? "work" : task.phase
  const action: MaestroAction = completed ? "finish" : stopped ? "stop" : phase === "review" ? "review" : "continue"
  const nextPrompt = action === "finish" || action === "stop" ? "" : promptFor(row)
  return {
    kind: "maestro-runner-state",
    jobId: task.id,
    taskToken,
    objective: task.objective,
    successCriterion: task.successCriterion,
    hardRules: task.hardRules,
    status: completed ? "completed" : stopped ? "cancelled" : "running",
    round: task.round,
    phase,
    action,
    checkpoint: task.checkpoint,
    unresolved: task.unresolved,
    nextActions: task.nextActions,
    evidence: task.evidence,
    candidateAnswer: task.candidateAnswer,
    finalAnswer: completed ? task.finalAnswer : "",
    criterionSatisfied: completed,
    reviewEvidence: task.reviewEvidence,
    completionVerified: completed,
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

function rejection(input: GateEvaluationInput, criterion: string) {
  const unresolved = [...input.unresolved]
  const nextActions = [...input.nextActions]
  if (!unresolved.length) unresolved.push(`不可变成功判据尚未被独立复核证明：${criterion}`)
  if (!nextActions.length) nextActions.push("返回 work，继续补足满足原始成功判据所需的实质证据或证明；不得降低、替换或重新解释成功判据。")
  return { unresolved, nextActions }
}

export function evaluateMaestroV4Gate(row: AgentTaskRow, input: GateEvaluationInput, taskToken: string): MaestroReportState {
  const task = publicMaestroTask(row)
  const meta = maestroMeta(row)
  if (!task || !meta) throw new Error("Maestro task metadata is invalid")
  if (task.status === "cancelled" || task.status === "completed") return storedState(row, taskToken)
  if (input.round <= meta.round) return storedState(row, taskToken)
  if (input.round !== meta.round + 1) throw new Error(`Expected Maestro round ${meta.round + 1}`)
  const expectedPhase: Exclude<MaestroPhase, "done"> = meta.phase === "review" ? "review" : "work"
  if (input.phase !== expectedPhase) throw new Error(`Expected Maestro phase ${expectedPhase}`)

  const hasGaps = input.unresolved.length > 0 || input.nextActions.length > 0
  const candidateReady = input.done && !hasGaps && Boolean(input.finalAnswer)
  let phase: MaestroPhase = "work"
  let action: MaestroAction = "continue"
  let candidateAnswer = meta.candidateAnswer
  let finalAnswer = ""
  let criterionSatisfied = false
  let reviewEvidence: string[] = []
  let completionVerified = false
  let unresolved = input.unresolved
  let nextActions = input.nextActions

  if (expectedPhase === "work" && candidateReady) {
    phase = "review"
    action = "review"
    candidateAnswer = input.finalAnswer
  } else if (expectedPhase === "review") {
    const verified = input.done && input.criterionSatisfied && !hasGaps && Boolean(input.finalAnswer) && input.reviewEvidence.length > 0
    if (verified) {
      phase = "done"
      action = "finish"
      candidateAnswer = meta.candidateAnswer || input.finalAnswer
      finalAnswer = input.finalAnswer
      criterionSatisfied = true
      reviewEvidence = input.reviewEvidence
      completionVerified = true
    } else {
      const rejected = rejection(input, task.successCriterion)
      unresolved = rejected.unresolved
      nextActions = rejected.nextActions
      reviewEvidence = input.reviewEvidence
    }
  }

  const nextPrompt = action === "finish" ? "" : maestroV4Prompt({
    objective: task.objective,
    successCriterion: task.successCriterion,
    hardRules: task.hardRules,
    nextRound: input.round + 1,
    phase,
    checkpoint: input.checkpoint,
    unresolved,
    nextActions,
    evidence: input.evidence,
    candidateAnswer,
  })

  return {
    kind: "maestro-runner-state",
    jobId: task.id,
    taskToken,
    objective: task.objective,
    successCriterion: task.successCriterion,
    hardRules: task.hardRules,
    status: completionVerified ? "completed" : "running",
    round: input.round,
    phase,
    action,
    checkpoint: input.checkpoint,
    unresolved,
    nextActions,
    evidence: input.evidence,
    candidateAnswer,
    finalAnswer,
    criterionSatisfied,
    reviewEvidence,
    completionVerified,
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

function requireUser(options: MaestroV4RpcOptions): string {
  const userId = options.userId?.trim()
  if (!userId) throw new Error("Maestro requires an authenticated My Chat user. Reconnect this app with OAuth.")
  return userId
}

async function latestQueuedTask(userId: string): Promise<AgentTaskRow> {
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const rows = await listMaestroTasks(admin, userId)
  const row = rows.find(item => item.status === "queued")
  if (!row) throw new Error("This authenticated user has no queued Maestro task to begin")
  return row
}

async function resolveTask(taskToken: string, userId: string) {
  const access = verifyMaestroTaskToken(taskToken)
  if (!access || access.userId !== userId) throw new Error("Invalid Maestro task capability")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await getMaestroTask(admin, userId, access.jobId)
  if (!row) throw new Error("Maestro task not found")
  return { admin, row, token: issueMaestroTaskToken({ userId, jobId: access.jobId }) }
}

async function claimNextRound(admin: NonNullable<ReturnType<typeof createAdminClient>>, row: AgentTaskRow, token: string) {
  const pending = storedState(row, token)
  if (!pending.nextPrompt || pending.status === "completed" || pending.status === "cancelled") return pending
  const claimed = await markMaestroRoundStarted(admin, row.user_id, row.id, pending.round + 1, pending.currentInput || pending.nextPrompt)
  const state = storedState(claimed.row, token)
  state.launchGranted = claimed.started
  return state
}

function textResult(state: MaestroReportState) {
  const text = state.action === "finish"
    ? "Maestro independent review verified the immutable success criterion. The Runner will stop."
    : state.action === "stop"
      ? "Maestro task was explicitly cancelled."
      : state.action === "review"
        ? "Candidate closure reached. The Runner will start a separate independent review turn."
        : "Maestro remains unfinished and resumable. The Runner controls the next turn."
  return { structuredContent: state, content: [{ type: "text", text }], _meta: { jobId: state.jobId } }
}

async function callCreate(args: unknown, userId: string) {
  const input = createInput(args)
  if (!input) throw new Error("Invalid Maestro task objective or contract")
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await createMaestroTask(admin, userId, input.objective, input.maxRounds, { successCriterion: input.successCriterion, hardRules: input.hardRules })
  const token = issueMaestroTaskToken({ userId, jobId: row.id })
  return textResult(await claimNextRound(admin, row, token))
}

async function callBegin(userId: string) {
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")
  const row = await latestQueuedTask(userId)
  const token = issueMaestroTaskToken({ userId, jobId: row.id })
  return textResult(await claimNextRound(admin, row, token))
}

async function callSync(args: unknown, userId: string) {
  const input = syncInput(args)
  if (!input) throw new Error("Invalid internal Maestro synchronization capability")
  const resolved = await resolveTask(input.taskToken, userId)
  return textResult(await claimNextRound(resolved.admin, resolved.row, resolved.token))
}

function elapsedMs(startedAt: string | null, fallback: string): number {
  const start = Date.parse(startedAt || fallback)
  return Number.isFinite(start) ? Math.max(0, Date.now() - start) : 0
}

async function callGate(args: unknown, userId: string) {
  const input = gateInput(args)
  if (!input) throw new Error("Invalid Maestro round checkpoint")
  const resolved = await resolveTask(input.taskToken, userId)
  const meta = maestroMeta(resolved.row)
  if (!meta) throw new Error("Maestro task metadata is invalid")
  if (input.round <= meta.round) return textResult(storedState(resolved.row, resolved.token))
  const prior = storedState(resolved.row, resolved.token)
  const state = evaluateMaestroV4Gate(resolved.row, input, resolved.token)
  const now = new Date().toISOString()
  const roundElapsed = elapsedMs(meta.currentRoundStartedAt, resolved.row.updated_at || resolved.row.created_at)
  const roundRecord: MaestroRoundRecord = {
    round: input.round,
    phase: input.phase,
    input: meta.currentInput || prior.currentInput || prior.nextPrompt,
    output: input.roundOutput || input.checkpoint,
    checkpoint: input.checkpoint,
    action: state.action,
    startedAt: meta.currentRoundStartedAt || resolved.row.updated_at || resolved.row.created_at,
    finishedAt: now,
    elapsedMs: roundElapsed,
    criterionSatisfied: state.criterionSatisfied,
    reviewEvidence: state.reviewEvidence,
    completionVerified: state.completionVerified,
  }
  state.history = [...meta.history.filter(item => item.round < input.round), roundRecord].slice(-100)
  state.totalElapsedMs = meta.totalElapsedMs + roundElapsed
  state.lastOutput = roundRecord.output
  state.currentInput = state.nextPrompt
  state.currentRoundStartedAt = null
  state.updatedAt = now
  state.launchGranted = false
  await applyMaestroReport(resolved.admin, userId, resolved.row.id, state)
  return textResult(state)
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function resource() {
  return {
    uri: MAESTRO_V4_WIDGET_URI,
    mimeType: "text/html;profile=mcp-app",
    text: MAESTRO_V4_WIDGET_HTML,
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetDescription": "Maestro Runner v4: zero-code automatic cross-turn continuation with immutable completion criteria.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    },
  }
}

export async function handleMaestroV4Rpc(value: unknown, options: MaestroV4RpcOptions): Promise<JsonRpcResponse | null> {
  const body = record(value) as Rpc | null
  const id = body?.id ?? null
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(id, -32600, "Invalid Request")
  if (body.method.startsWith("notifications/")) return null
  if (body.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: MAESTRO_V4_PROTOCOL_VERSION, capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, serverInfo: { name: MAESTRO_V4_SERVER_NAME, version: MAESTRO_V4_SERVER_VERSION }, instructions: "For a new task created inside ChatGPT call maestro_create_task. For a task launched from My Chat call maestro_begin with an empty object, then end the current turn; the attached Runner starts the first worker turn. Never ask the user for a start code, token, task id, or relay value. Objective, successCriterion, and hardRules are immutable. Work never finishes. Only a separate independent review may finish after strictly verifying the exact success criterion with non-empty reviewEvidence. Runtime/tool/time/token/round limits, inability, lack of progress, or unknown methods never count as completion. Every worker/review turn ends with maestro_round_gate; the Runner synchronizes later turns with app-only maestro_sync." } }
  if (body.method === "ping") return { jsonrpc: "2.0", id, result: {} }
  if (body.method === "tools/list") {
    console.log(`[maestro-v4] tools/list ${MAESTRO_V4_SERVER_NAME}@${MAESTRO_V4_SERVER_VERSION}: ${MAESTRO_V4_TOOLS.map(tool => tool.name).join(",")}`)
    return { jsonrpc: "2.0", id, result: { tools: MAESTRO_V4_TOOLS } }
  }
  if (body.method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [{ uri: MAESTRO_V4_WIDGET_URI, name: "Maestro Runner v4", mimeType: "text/html;profile=mcp-app" }] } }
  if (body.method === "resources/templates/list") return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } }
  if (body.method === "resources/read") {
    const params = record(body.params)
    if (params?.uri !== MAESTRO_V4_WIDGET_URI) return rpcError(id, -32002, "Resource not found")
    return { jsonrpc: "2.0", id, result: { contents: [resource()] } }
  }
  if (body.method === "tools/call") {
    const params = record(body.params)
    try {
      const userId = requireUser(options)
      if (params?.name === "maestro_create_task") return { jsonrpc: "2.0", id, result: await callCreate(params.arguments, userId) }
      if (params?.name === "maestro_begin") return { jsonrpc: "2.0", id, result: await callBegin(userId) }
      if (params?.name === "maestro_sync") return { jsonrpc: "2.0", id, result: await callSync(params.arguments, userId) }
      if (params?.name === "maestro_round_gate") return { jsonrpc: "2.0", id, result: await callGate(params.arguments, userId) }
      return rpcError(id, -32602, "Unknown Maestro v4 tool")
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Maestro v4 tool failed" }] } }
    }
  }
  return rpcError(id, -32601, "Method not found")
}
