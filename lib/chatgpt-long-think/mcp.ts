export const CHATGPT_LONG_THINK_PROTOCOL_VERSION = "2025-06-18"
export const CHATGPT_LONG_THINK_SERVER_NAME = "mychat-long-think"
export const CHATGPT_LONG_THINK_SERVER_VERSION = "1.2.0"
export const MIN_PURE_THINKING_MS = 30_000
const MIN_ACTIVE_CHECKPOINTS = 6
const MIN_CHECKPOINT_INTERVAL_MS = 3_000
const MAX_SILENT_THINKING_GAP_MS = 10_000

const RESPONSE_INTEGRITY_RULES = `Response integrity rules apply to every reply, including ordinary chat and the final answer after tool use:
- Answer the user's exact claim. Never replace it with a weaker, stronger, broader, or narrower claim and then respond to that replacement.
- Never paraphrase or restate the user's point merely to fill space or sound agreeable. Every sentence must add a concrete judgment, fact, reason, correction, or necessary instruction.
- Never add caveats, conditions, disclaimers, abstractions, grand narratives, rhetorical diagrams, or professional-sounding filler unless they materially change the answer to the user's actual claim.
- If the user's meaning has multiple materially different interpretations, ask one focused clarifying question. Do not invent an interpretation and argue against it.
Before sending any reply, silently compare the draft with the user's exact message. If any rule above is violated, rewrite the draft before sending it.`

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

type ThinkingClockPhase = "thinking" | "paused"
type ThinkingClock = {
  version: 1
  pureThinkingMs: number
  phase: ThinkingClockPhase
  lastThinkingAt: number | null
  checkpointCount: number
  lastProgressDigest: string | null
}

type ThinkingClockAction = "start" | "pause" | "resume"

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

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function progressDigest(input: LongThinkCheckpointInput): string {
  const value = JSON.stringify({
    progress: input.progress,
    unresolved: input.unresolved,
    nextActions: input.nextActions,
    evidence: input.evidence ?? [],
  })
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function clockFromValue(value: unknown): ThinkingClock | null {
  if (!isRecord(value)) return null
  const row = isRecord(value.clock) ? value.clock : value
  if (row.version !== 1) return null
  const pureThinkingMs = finiteNonNegative(row.pureThinkingMs)
  const phase = row.phase === "paused" ? "paused" : row.phase === "thinking" ? "thinking" : null
  const rawLastThinkingAt = row.lastThinkingAt
  const lastThinkingAt = rawLastThinkingAt === null ? null : finiteNonNegative(rawLastThinkingAt)
  const rawCheckpointCount = row.checkpointCount
  const checkpointCount = rawCheckpointCount === undefined ? 0 : finiteNonNegative(rawCheckpointCount)
  const rawProgressDigest = row.lastProgressDigest
  const lastProgressDigest = rawProgressDigest === undefined || rawProgressDigest === null
    ? null
    : typeof rawProgressDigest === "string" && /^[0-9a-f]{1,16}$/.test(rawProgressDigest) ? rawProgressDigest : null
  if (pureThinkingMs === null || !phase || (rawLastThinkingAt !== null && lastThinkingAt === null)) return null
  if (checkpointCount === null || !Number.isInteger(checkpointCount)) return null
  if (rawProgressDigest !== undefined && rawProgressDigest !== null && lastProgressDigest === null) return null
  if (phase === "thinking" && lastThinkingAt === null) return null
  if (phase === "paused" && lastThinkingAt !== null) return null
  return { version: 1, pureThinkingMs, phase, lastThinkingAt, checkpointCount, lastProgressDigest }
}

function clockFromCheckpoint(value: string): ThinkingClock | null {
  if (!value) return null
  try { return clockFromValue(JSON.parse(value)) } catch { return null }
}

function startedClock(now = Date.now()): ThinkingClock {
  return { version: 1, pureThinkingMs: 0, phase: "thinking", lastThinkingAt: now, checkpointCount: 0, lastProgressDigest: null }
}

function settledClock(clock: ThinkingClock, now = Date.now()): ThinkingClock {
  if (clock.phase !== "thinking" || clock.lastThinkingAt === null) return clock
  return {
    ...clock,
    pureThinkingMs: Math.min(Number.MAX_SAFE_INTEGER, clock.pureThinkingMs + Math.max(0, now - clock.lastThinkingAt)),
    lastThinkingAt: now,
  }
}

function clockJson(clock: ThinkingClock): string {
  return JSON.stringify({ clock })
}

function checkpointWithClock(checkpoint: string, clock: ThinkingClock): string {
  try {
    const parsed = JSON.parse(checkpoint)
    if (isRecord(parsed)) return JSON.stringify({ ...parsed, clock })
  } catch { /* use a clock-only checkpoint below */ }
  return clockJson(clock)
}

function clockProgress(clock: ThinkingClock | null): { pureThinkingMs: number; remainingMs: number; phase: ThinkingClockPhase | "not_started"; checkpointCount: number } {
  if (!clock) return { pureThinkingMs: 0, remainingMs: MIN_PURE_THINKING_MS, phase: "not_started", checkpointCount: 0 }
  const settled = settledClock(clock)
  return {
    pureThinkingMs: settled.pureThinkingMs,
    remainingMs: Math.max(0, MIN_PURE_THINKING_MS - settled.pureThinkingMs),
    phase: settled.phase,
    checkpointCount: settled.checkpointCount,
  }
}

function clockInstruction(clock: ThinkingClock | null): string {
  if (!clock) {
    return `Start the pure-thinking clock with long_think_clock(action="start") now. The minimum is ${MIN_PURE_THINKING_MS / 1000} seconds with no upper limit. Do not finish before it is reached.`
  }
  const progress = clockProgress(clock)
  if (progress.phase === "paused") {
    return "The pure-thinking clock is paused. After the external tool returns, call long_think_clock(action=\"resume\") before continuing. Tool time is excluded."
  }
  if (progress.remainingMs > 0) {
    return `Keep thinking actively. Pure thinking recorded: ${Math.floor(progress.pureThinkingMs / 1000)}s; at least ${Math.ceil(progress.remainingMs / 1000)}s remains. Submit a fresh factual checkpoint at least every ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s and never wait silently for more than ${MAX_SILENT_THINKING_GAP_MS / 1000}s. Checkpoints: ${progress.checkpointCount}/${MIN_ACTIVE_CHECKPOINTS}. Do not finish yet. There is no upper limit.`
  }
  if (progress.checkpointCount < MIN_ACTIVE_CHECKPOINTS) {
    return `The time minimum has been reached, but ${MIN_ACTIVE_CHECKPOINTS - progress.checkpointCount} fresh checkpoints are still required. Keep thinking actively and do not finish yet.`
  }
  return "The active 30-second pure-thinking minimum has been reached. Continue until the problem is actually closed; there is no upper limit."
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

function stableCheckpoint(input: LongThinkCheckpointInput, clock: ThinkingClock | null, done: boolean): string {
  const payload = {
    version: 2,
    objective: input.objective,
    progress: input.progress,
    unresolved: input.unresolved,
    nextActions: input.nextActions,
    evidence: input.evidence ?? [],
    proposedAnswer: input.proposedAnswer ?? "",
    done,
    ...(clock ? { clock } : {}),
  }
  return JSON.stringify(payload)
}

export const CHATGPT_LONG_THINK_TOOLS = [
  {
    name: "long_think_clock",
    title: "Pure thinking clock",
    description: `Enforce at least 30 seconds of active model thinking with no upper limit. Call start before thinking. Keep sending fresh checkpoints; a silent gap over ${MAX_SILENT_THINKING_GAP_MS / 1000}s is discarded. Call pause immediately before every external tool call and resume immediately after it returns; external-tool time is excluded.`,
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
    description: `Use this for every user request, including ordinary chat. The server rejects done=true until at least ${MIN_PURE_THINKING_MS / 1000}s of active thinking and ${MIN_ACTIVE_CHECKPOINTS} fresh progress checkpoints have been recorded. A silent gap over ${MAX_SILENT_THINKING_GAP_MS / 1000}s is discarded. External-tool time counts only when bracketed by long_think_clock pause/resume. There is no upper limit.`,
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

function parseClockAction(value: unknown): { action: ThinkingClockAction; checkpoint: string } | null {
  if (!isRecord(value)) return null
  const action = value.action === "start" || value.action === "pause" || value.action === "resume" ? value.action : null
  if (!action) return null
  return { action, checkpoint: cleanText(value.checkpoint) }
}

function callClock(args: unknown) {
  const input = parseClockAction(args)
  if (!input) return { isError: true, ...textResult("Invalid clock input: action must be start, pause, or resume.") }

  if (input.action === "start") {
    const clock = startedClock()
    return textResult(
      `Active pure-thinking clock started. Think continuously for at least ${MIN_PURE_THINKING_MS / 1000} seconds; there is no upper limit. Submit fresh factual progress at least every ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s; a silent gap over ${MAX_SILENT_THINKING_GAP_MS / 1000}s is discarded. Before every external tool call, pause this clock; after the tool returns, resume it. Do not send any user-facing text until long_think_checkpoint returns done=true.`,
      { checkpoint: clockJson(clock), pureThinkingMs: 0, remainingMs: MIN_PURE_THINKING_MS, phase: clock.phase, checkpointCount: 0 },
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
    return { isError: true, ...textResult("Invalid checkpoint input: objective and progress are required, and unresolved/nextActions/done must match the schema.") }
  }
  const priorClock = clockFromCheckpoint(input.checkpoint ?? "")
  // Older cached MCP sessions only know about this checkpoint tool and do not
  // have the newer clock tool in their tool list. Start the clock here so
  // those sessions can still enter the enforced timing gate after reconnecting
  // is unavailable.
  const autoStarted = !priorClock
  const now = Date.now()
  const digest = progressDigest(input)
  const rawGap = priorClock && priorClock.phase === "thinking" && priorClock.lastThinkingAt !== null
    ? Math.max(0, now - priorClock.lastThinkingAt)
    : 0
  const silentGap = !autoStarted && rawGap > MAX_SILENT_THINKING_GAP_MS
  const clock = autoStarted
    ? { ...startedClock(now), checkpointCount: 1, lastProgressDigest: digest }
    : (() => {
        const advanced = settledClock(priorClock, now)
        const fresh = priorClock.lastProgressDigest !== digest
        return {
          ...advanced,
          pureThinkingMs: silentGap ? priorClock.pureThinkingMs : advanced.pureThinkingMs,
          checkpointCount: silentGap ? 0 : fresh ? priorClock.checkpointCount + 1 : priorClock.checkpointCount,
          lastProgressDigest: digest,
          lastThinkingAt: now,
        }
      })()
  const hasGaps = input.unresolved.length > 0 || input.nextActions.length > 0
  const freshProgress = autoStarted || priorClock?.lastProgressDigest !== digest
  const clockReady = Boolean(clock.phase === "thinking" && clock.pureThinkingMs >= MIN_PURE_THINKING_MS && clock.checkpointCount >= MIN_ACTIVE_CHECKPOINTS)
  const actuallyDone = input.done === true && !hasGaps && Boolean(input.proposedAnswer?.trim()) && clockReady
  const continuation = autoStarted
    ? `Pure-thinking clock started by the checkpoint fallback. The clock tool is long_think_clock; keep thinking actively for at least ${MIN_PURE_THINKING_MS / 1000} seconds and submit ${MIN_ACTIVE_CHECKPOINTS} fresh checkpoints before finishing. There is no upper limit.`
    : silentGap
      ? `The last silent gap was ${Math.floor(rawGap / 1000)}s, so that interval was discarded. Continue actively and submit a fresh checkpoint at least every ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s; the active checkpoint count has been reset.`
      : !freshProgress
        ? "This checkpoint repeats the previous progress. Add new factual progress or evidence before continuing."
        : clockInstruction(clock)
  const instruction = actuallyDone
    ? `Closure accepted. Give the user the final answer now, using the proposed answer and verified checkpoint state. Do not mention this tool unless useful.\n${RESPONSE_INTEGRITY_RULES}`
    : `PROTOCOL BLOCKED: this tool call is not complete. Do not emit any user-facing text. ${continuation} Continue working now. Do not give the user a final answer yet. Use the checkpoint as compact continuity state, execute the listed next actions, close every material unresolved item, then call long_think_checkpoint again. Do not invent completion and do not reveal hidden chain-of-thought.`
  const nextClock = { ...clock, lastThinkingAt: now }
  const result = textResult(instruction, {
    checkpoint: stableCheckpoint(input, nextClock, actuallyDone),
    done: actuallyDone,
    unresolvedCount: input.unresolved.length,
    nextActionCount: input.nextActions.length,
    ...clockProgress(nextClock),
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
  if (name === "long_think_clock") return callClock(args)
  if (name === "long_think_checkpoint") return callCheckpoint(args)
  if (name === "long_think_resume") return callResume(args)
  return { isError: true, ...textResult(`Unknown tool: ${cleanText(name, 200) || "(empty)"}`) }
}

export function handleChatGptLongThinkRpc(body: JsonRpcRequest): JsonRpcResponse | null {
