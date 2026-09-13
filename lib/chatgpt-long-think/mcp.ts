export const CHATGPT_LONG_THINK_PROTOCOL_VERSION = "2025-06-18"
export const CHATGPT_LONG_THINK_SERVER_NAME = "mychat-long-think"
export const CHATGPT_LONG_THINK_SERVER_VERSION = "1.4.0"
export const MIN_PURE_THINKING_MS = 30_000
const MIN_ACTIVE_CHECKPOINTS = 6
const MIN_CHECKPOINT_INTERVAL_MS = 3_000
const MAX_SILENT_THINKING_GAP_MS = 10_000

const THINKING_STAGES = [
  { name: "decompose", instruction: "split the exact request into concrete claims and constraints" },
  { name: "analyze", instruction: "work through the claims and compare the viable answers" },
  { name: "verify", instruction: "check the important facts, calculations, and assumptions" },
  { name: "challenge", instruction: "try to falsify the current answer and find edge cases" },
  { name: "recheck", instruction: "independently re-evaluate the result and close remaining gaps" },
  { name: "synthesize", instruction: "write the concise final answer from the verified result" },
] as const
type ThinkingStage = typeof THINKING_STAGES[number]["name"]

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
  stage: string
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
  stageIndex: number
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

type ParsedTimestamp = { value: number | null; valid: boolean }

function parseClockPhase(value: unknown): ThinkingClockPhase | null {
  if (value === "thinking" || value === "paused") return value
  return null
}

function parseClockTimestamp(value: unknown): ParsedTimestamp {
  if (value === null) return { value: null, valid: true }
  const parsed = finiteNonNegative(value)
  return { value: parsed, valid: parsed !== null }
}

function parseClockCount(value: unknown): number | null {
  const parsed = value === undefined ? 0 : finiteNonNegative(value)
  return parsed !== null && Number.isInteger(parsed) ? parsed : null
}

function parseClockStageIndex(value: unknown, checkpointCount: number): number | null {
  const parsed = value === undefined ? Math.min(checkpointCount, THINKING_STAGES.length) : finiteNonNegative(value)
  if (parsed === null || !Number.isInteger(parsed) || parsed > THINKING_STAGES.length) return null
  return parsed
}

function parseClockDigest(value: unknown): { value: string | null; valid: boolean } {
  if (value === undefined || value === null) return { value: null, valid: true }
  const valid = typeof value === "string" && /^[0-9a-f]{1,16}$/.test(value)
  return { value: valid ? value : null, valid }
}

function validClockPhaseTimestamp(phase: ThinkingClockPhase, timestamp: number | null): boolean {
  return phase === "thinking" ? timestamp !== null : timestamp === null
}

function validClockFields(
  pureThinkingMs: number | null,
  phase: ThinkingClockPhase | null,
  timestamp: ParsedTimestamp,
  checkpointCount: number | null,
  stageIndex: number | null,
  digest: { value: string | null; valid: boolean },
): boolean {
  return pureThinkingMs !== null
    && phase !== null
    && timestamp.valid
    && checkpointCount !== null
    && stageIndex !== null
    && digest.valid
}

function progressDigest(input: LongThinkCheckpointInput): string {
  const value = JSON.stringify({
    stage: input.stage,
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
  const phase = parseClockPhase(row.phase)
  const timestamp = parseClockTimestamp(row.lastThinkingAt)
  const checkpointCount = parseClockCount(row.checkpointCount)
  const stageIndex = checkpointCount === null ? null : parseClockStageIndex(row.stageIndex, checkpointCount)
  const digest = parseClockDigest(row.lastProgressDigest)
  if (!validClockFields(pureThinkingMs, phase, timestamp, checkpointCount, stageIndex, digest)
    || phase === null || checkpointCount === null || stageIndex === null || pureThinkingMs === null) return null
  if (!validClockPhaseTimestamp(phase, timestamp.value)) return null
  return { version: 1, pureThinkingMs, phase, lastThinkingAt: timestamp.value, checkpointCount, lastProgressDigest: digest.value, stageIndex }
}

function clockFromCheckpoint(value: string): ThinkingClock | null {
  if (!value) return null
  try { return clockFromValue(JSON.parse(value)) } catch { return null }
}

function startedClock(now = Date.now()): ThinkingClock {
  return { version: 1, pureThinkingMs: 0, phase: "thinking", lastThinkingAt: now, checkpointCount: 0, lastProgressDigest: null, stageIndex: 0 }
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

function clockProgress(clock: ThinkingClock | null): { pureThinkingMs: number; remainingMs: number; phase: ThinkingClockPhase | "not_started"; checkpointCount: number; stageIndex: number; nextStage: ThinkingStage | "complete" } {
  if (!clock) return { pureThinkingMs: 0, remainingMs: MIN_PURE_THINKING_MS, phase: "not_started", checkpointCount: 0, stageIndex: 0, nextStage: THINKING_STAGES[0].name }
  const settled = settledClock(clock)
  return {
    pureThinkingMs: settled.pureThinkingMs,
    remainingMs: Math.max(0, MIN_PURE_THINKING_MS - settled.pureThinkingMs),
    phase: settled.phase,
    checkpointCount: settled.checkpointCount,
    stageIndex: settled.stageIndex,
    nextStage: THINKING_STAGES[settled.stageIndex]?.name ?? "complete",
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
    const stage = THINKING_STAGES[progress.stageIndex]
    return `Keep thinking actively. Pure thinking recorded: ${Math.floor(progress.pureThinkingMs / 1000)}s; at least ${Math.ceil(progress.remainingMs / 1000)}s remains. Complete the next stage (${stage?.name ?? "synthesize"}): ${stage?.instruction ?? THINKING_STAGES[5].instruction}. Submit it as a new checkpoint after at least ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s and never wait silently for more than ${MAX_SILENT_THINKING_GAP_MS / 1000}s. Checkpoints: ${progress.checkpointCount}/${MIN_ACTIVE_CHECKPOINTS}. Do not finish yet. There is no upper limit.`
  }
  if (progress.checkpointCount < MIN_ACTIVE_CHECKPOINTS) {
    const stage = THINKING_STAGES[progress.stageIndex]
    return `The time minimum has been reached, but ${MIN_ACTIVE_CHECKPOINTS - progress.checkpointCount} ordered work stages are still required. Complete ${stage?.name ?? "synthesize"}: ${stage?.instruction ?? THINKING_STAGES[5].instruction}. Keep thinking actively and do not finish yet.`
  }
  return "The active 30-second pure-thinking minimum has been reached. Continue until the problem is actually closed; there is no upper limit."
}

function checkpointInput(value: unknown): LongThinkCheckpointInput | null {
  if (!isRecord(value)) return null
  const objective = cleanText(value.objective)
  const stage = cleanText(value.stage, 64)
  const progress = cleanText(value.progress)
  if (!objective || !stage || !progress) return null
  return {
    objective,
    stage,
    checkpoint: cleanText(value.checkpoint),
    progress,
    unresolved: cleanList(value.unresolved),
    nextActions: cleanList(value.nextActions),
    evidence: cleanList(value.evidence),
    proposedAnswer: cleanText(value.proposedAnswer),
    done: value.done === true,
  }
}

function stageIndexFor(value: string): number {
  return THINKING_STAGES.findIndex(stage => stage.name === value)
}

function hasOpenWork(input: LongThinkCheckpointInput): boolean {
  return input.unresolved.length > 0 || input.nextActions.length > 0
}

function stageWorkError(input: LongThinkCheckpointInput, stageIndex: number): string | null {
  if (stageIndex < 0 || stageIndex >= THINKING_STAGES.length) return "stage must be one of decompose, analyze, verify, challenge, recheck, or synthesize."
  if (input.progress.length < 24) return "Each checkpoint needs at least 24 characters of concrete progress; a one-line filler update is not accepted."
  switch (stageIndex) {
    case 0:
      return hasOpenWork(input) ? null : "The decompose stage must list at least one unresolved question or next action."
    case 2:
      return (input.evidence ?? []).length > 0 ? null : "The verify stage must include at least one checked fact, calculation, or source in evidence."
    case 3:
      return hasOpenWork(input) ? null : "The challenge stage must record a possible failure, edge case, or explicit falsification check."
    case 5:
      return input.proposedAnswer?.trim() ? null : "The synthesize stage must include a proposedAnswer built from the checked result."
    default:
      return null
  }
}

function stableCheckpoint(input: LongThinkCheckpointInput, clock: ThinkingClock | null, done: boolean): string {
  const payload = {
    version: 2,
    objective: input.objective,
    stage: input.stage,
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

type CheckpointEvaluation = {
  clock: ThinkingClock
  acceptedProgress: boolean
  continuation: string
}

function checkpointReady(input: LongThinkCheckpointInput, evaluation: CheckpointEvaluation): boolean {
  return evaluation.acceptedProgress
    && evaluation.clock.phase === "thinking"
    && evaluation.clock.pureThinkingMs >= MIN_PURE_THINKING_MS
    && evaluation.clock.stageIndex >= THINKING_STAGES.length
    && evaluation.clock.checkpointCount >= MIN_ACTIVE_CHECKPOINTS
    && !hasOpenWork(input)
    && Boolean(input.proposedAnswer?.trim())
    && input.done === true
}

function checkpointInstruction(input: LongThinkCheckpointInput, evaluation: CheckpointEvaluation, actuallyDone: boolean): string {
  if (actuallyDone) return `Closure accepted. Give the user the final answer now, using the proposed answer and verified checkpoint state. Do not mention this tool unless useful.\n${RESPONSE_INTEGRITY_RULES}`
  return `PROTOCOL BLOCKED: this tool call is not complete. Do not emit any user-facing text. ${evaluation.continuation} Continue working now. Do not give the user a final answer yet. Use the checkpoint as compact continuity state, execute the listed next actions, close every material unresolved item, then call long_think_checkpoint again. Do not invent completion and do not reveal hidden chain-of-thought.`
}

type CheckpointFacts = {
  digest: string
  rawGap: number
  stageIndex: number
  expectedStageIndex: number
  silentGap: boolean
  earlyGap: boolean
  paused: boolean
  freshProgress: boolean
}

function checkpointFacts(input: LongThinkCheckpointInput, priorClock: ThinkingClock, now: number): CheckpointFacts {
  const digest = progressDigest(input)
  const rawGap = priorClock.phase === "thinking" && priorClock.lastThinkingAt !== null
    ? Math.max(0, now - priorClock.lastThinkingAt)
    : 0
  return {
    digest,
    rawGap,
    stageIndex: stageIndexFor(input.stage),
    expectedStageIndex: Math.min(priorClock.stageIndex, THINKING_STAGES.length - 1),
    silentGap: priorClock.phase === "thinking" && rawGap > MAX_SILENT_THINKING_GAP_MS,
    earlyGap: priorClock.phase === "thinking" && rawGap < MIN_CHECKPOINT_INTERVAL_MS,
    paused: priorClock.phase === "paused",
    freshProgress: priorClock.lastProgressDigest !== digest,
  }
}

function timingEvaluation(priorClock: ThinkingClock, facts: CheckpointFacts, now: number): CheckpointEvaluation | null {
  if (facts.paused) {
    return {
      clock: priorClock,
      acceptedProgress: false,
      continuation: "The pure-thinking clock is paused. Call long_think_clock(action=\"resume\") before submitting another checkpoint; external-tool time is excluded.",
    }
  }
  if (facts.silentGap) {
    return {
      clock: { ...priorClock, checkpointCount: 0, stageIndex: 0, lastProgressDigest: null, lastThinkingAt: now },
      acceptedProgress: false,
      continuation: `The silent gap was ${Math.floor(facts.rawGap / 1000)}s, so that interval was discarded. Start again at ${THINKING_STAGES[0].name} and submit a new checkpoint after at least ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s; do not leave the clock idle for more than ${MAX_SILENT_THINKING_GAP_MS / 1000}s.`,
    }
  }
  if (facts.earlyGap) {
    return {
      clock: priorClock,
      acceptedProgress: false,
      continuation: `This checkpoint arrived ${Math.max(0, facts.rawGap)}ms after the previous one. Wait at least ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s while doing the next stage's work; rapid tool calls are not counted.`,
    }
  }
  return null
}

function stageEvaluation(input: LongThinkCheckpointInput, priorClock: ThinkingClock, facts: CheckpointFacts): CheckpointEvaluation | null {
  if (!facts.freshProgress) {
    return {
      clock: priorClock,
      acceptedProgress: false,
      continuation: "This checkpoint repeats the previous work product. Add a genuinely new conclusion, check, edge case, or decision before continuing.",
    }
  }
  if (facts.stageIndex !== facts.expectedStageIndex) {
    const expected = THINKING_STAGES[facts.expectedStageIndex]?.name ?? THINKING_STAGES[THINKING_STAGES.length - 1].name
    return {
      clock: priorClock,
      acceptedProgress: false,
      continuation: `Stage order is wrong. The next required stage is ${expected}; complete it before submitting ${input.stage}.`,
    }
  }
  const workError = stageWorkError(input, facts.stageIndex)
  if (workError) return { clock: priorClock, acceptedProgress: false, continuation: workError }
  return null
}

function evaluateCheckpoint(input: LongThinkCheckpointInput, priorClock: ThinkingClock | null, now: number): CheckpointEvaluation {
  if (!priorClock) {
    return {
      clock: startedClock(now),
      acceptedProgress: false,
      continuation: `The clock was started by this fallback call. Keep working through the six ordered stages and submit the first (${THINKING_STAGES[0].name}) checkpoint after at least ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s of active work. A checkpoint sent immediately after starting is not counted.`,
    }
  }
  const facts = checkpointFacts(input, priorClock, now)
  const timing = timingEvaluation(priorClock, facts, now)
  if (timing) return timing
  const stage = stageEvaluation(input, priorClock, facts)
  if (stage) return stage
  const advanced = settledClock(priorClock, now)
  const nextClock: ThinkingClock = {
    ...advanced,
    checkpointCount: Math.min(MIN_ACTIVE_CHECKPOINTS, priorClock.checkpointCount + 1),
    stageIndex: Math.min(THINKING_STAGES.length, priorClock.stageIndex + 1),
    lastProgressDigest: facts.digest,
    lastThinkingAt: now,
  }
  return {
    clock: nextClock,
    acceptedProgress: true,
    continuation: clockInstruction(nextClock),
  }
}

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
    "THINKING MODE TRIGGERED. Treat this as the user's explicit command to switch this turn from fast/instant generation to thinking mode. Continue the user's actual request in thinking mode now. Do not answer in fast mode and do not mention this trigger.",
    { thinking: true, mode: "thinking", trigger: "user_button", requestedAt: Date.now() },
  )
}

function callClock(args: unknown) {
  const input = parseClockAction(args)
  if (!input) return { isError: true, ...textResult("Invalid clock input: action must be start, pause, or resume.") }

  if (input.action === "start") {
    const clock = startedClock()
    return textResult(
      `Active pure-thinking clock started. Think continuously for at least ${MIN_PURE_THINKING_MS / 1000} seconds; there is no upper limit. Submit fresh factual progress at least every ${MIN_CHECKPOINT_INTERVAL_MS / 1000}s; a silent gap over ${MAX_SILENT_THINKING_GAP_MS / 1000}s is discarded. Before every external tool call, pause this clock; after the tool returns, resume it. Do not send any user-facing text until long_think_checkpoint returns done=true.`,
      { checkpoint: clockJson(clock), pureThinkingMs: 0, remainingMs: MIN_PURE_THINKING_MS, phase: clock.phase, checkpointCount: 0, stageIndex: 0, nextStage: THINKING_STAGES[0].name },
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
  const instruction = checkpointInstruction(input, evaluation, actuallyDone)
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
