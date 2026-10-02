export const CHATGPT_LONG_THINK_PROTOCOL_VERSION = "2025-06-18"
export const CHATGPT_LONG_THINK_SERVER_NAME = "mychat-long-think"
export const CHATGPT_LONG_THINK_SERVER_VERSION = "1.4.1"
export const MIN_PURE_THINKING_MS = 30_000
export const MIN_ACTIVE_CHECKPOINTS = 6
export const MIN_CHECKPOINT_INTERVAL_MS = 3_000
export const MAX_SILENT_THINKING_GAP_MS = 10_000

export const THINKING_STAGES = [
  { name: "decompose", instruction: "split the exact request into concrete claims and constraints" },
  { name: "analyze", instruction: "work through the claims and compare the viable answers" },
  { name: "verify", instruction: "check the important facts, calculations, and assumptions" },
  { name: "challenge", instruction: "try to falsify the current answer and find edge cases" },
  { name: "recheck", instruction: "independently re-evaluate the result and close remaining gaps" },
  { name: "synthesize", instruction: "write the concise final answer from the verified result" },
] as const
export type ThinkingStage = typeof THINKING_STAGES[number]["name"]

export const RESPONSE_INTEGRITY_RULES = `Response integrity rules apply to every reply, including ordinary chat and the final answer after tool use:
- Answer the user's exact claim. Never replace it with a weaker, stronger, broader, or narrower claim and then respond to that replacement.
- Never paraphrase or restate the user's point merely to fill space or sound agreeable. Every sentence must add a concrete judgment, fact, reason, correction, or necessary instruction.
- Never add caveats, conditions, disclaimers, abstractions, grand narratives, rhetorical diagrams, or professional-sounding filler unless they materially change the answer to the user's actual claim.
- If the user's meaning has multiple materially different interpretations, ask one focused clarifying question. Do not invent an interpretation and argue against it.
Before sending any reply, silently compare the draft with the user's exact message. If any rule above is violated, rewrite the draft before sending it.`

export const THINKING_TRIGGER_MESSAGE = "THINKING MODE TRIGGERED. Treat this as the user's explicit command to switch this turn from fast/instant generation to thinking mode. Continue the user's actual request in thinking mode now. Do not answer in fast mode and do not mention this trigger."

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

export type LongThinkCheckpointInput = {
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

export type ThinkingClockPhase = "thinking" | "paused"
export type ThinkingClock = {
  version: 1
  pureThinkingMs: number
  phase: ThinkingClockPhase
  lastThinkingAt: number | null
  checkpointCount: number
  lastProgressDigest: string | null
  stageIndex: number
}

export type ThinkingClockAction = "start" | "pause" | "resume"
