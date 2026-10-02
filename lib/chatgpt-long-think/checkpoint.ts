import {
  cleanList,
  cleanText,
  isRecord,
  MAX_SILENT_THINKING_GAP_MS,
  MIN_ACTIVE_CHECKPOINTS,
  MIN_CHECKPOINT_INTERVAL_MS,
  MIN_PURE_THINKING_MS,
  THINKING_STAGES,
  type LongThinkCheckpointInput,
  type ThinkingClock,
} from "./thinking-contract"
import { clockInstruction, settledClock, startedClock } from "./clock"

export const RESPONSE_INTEGRITY_RULES = `Response integrity rules apply to every reply, including ordinary chat and the final answer after tool use:
- Answer the user's exact claim. Never replace it with a weaker, stronger, broader, or narrower claim and then respond to that replacement.
- Never paraphrase or restate the user's point merely to fill space or sound agreeable. Every sentence must add a concrete judgment, fact, reason, correction, or necessary instruction.
- Never add caveats, conditions, disclaimers, abstractions, grand narratives, rhetorical diagrams, or professional-sounding filler unless they materially change the answer to the user's actual claim.
- If the user's meaning has multiple materially different interpretations, ask one focused clarifying question. Do not invent an interpretation and argue against it.
Before sending any reply, silently compare the draft with the user's exact message. If any rule above is violated, rewrite the draft before sending it.`

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

export function checkpointInput(value: unknown): LongThinkCheckpointInput | null {
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

export function stableCheckpoint(input: LongThinkCheckpointInput, clock: ThinkingClock | null, done: boolean): string {
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

export function checkpointReady(input: LongThinkCheckpointInput, evaluation: CheckpointEvaluation): boolean {
  return evaluation.acceptedProgress
    && evaluation.clock.phase === "thinking"
    && evaluation.clock.pureThinkingMs >= MIN_PURE_THINKING_MS
    && evaluation.clock.stageIndex >= THINKING_STAGES.length
    && evaluation.clock.checkpointCount >= MIN_ACTIVE_CHECKPOINTS
    && !hasOpenWork(input)
    && Boolean(input.proposedAnswer?.trim())
    && input.done === true
}

export function checkpointInstruction(evaluation: CheckpointEvaluation, actuallyDone: boolean): string {
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

export function evaluateCheckpoint(input: LongThinkCheckpointInput, priorClock: ThinkingClock | null, now: number): CheckpointEvaluation {
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
