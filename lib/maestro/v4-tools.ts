import { MAESTRO_V4_WIDGET_URI } from "@/lib/maestro/widget-v4"

export const V4_MAX_LIST = 64
export const V4_MAX_OBJECTIVE = 100_000
export const V4_MAX_TOKEN = 4_096
export const V4_MAX_ROUND = 2_147_483_647

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
      criterionSatisfied: { type: "boolean" },
      reviewEvidence: { type: "array", items: { type: "string" } },
      completionVerified: { type: "boolean" },
    },
    required: ["round", "phase", "input", "output", "checkpoint", "action", "startedAt", "finishedAt", "elapsedMs", "criterionSatisfied", "reviewEvidence", "completionVerified"],
    additionalProperties: false,
  }
}

function stateSchema() {
  return {
    type: "object",
    properties: {
      kind: { type: "string", const: "maestro-runner-state" },
      jobId: { type: "string" },
      taskToken: { type: "string", description: "Internal capability. Never ask the user for it or display it." },
      objective: { type: "string" },
      successCriterion: { type: "string" },
      hardRules: { type: "array", items: { type: "string" } },
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
      criterionSatisfied: { type: "boolean" },
      reviewEvidence: { type: "array", items: { type: "string" } },
      completionVerified: { type: "boolean" },
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
    required: ["kind", "jobId", "taskToken", "objective", "successCriterion", "hardRules", "status", "round", "phase", "action", "checkpoint", "unresolved", "nextActions", "evidence", "candidateAnswer", "finalAnswer", "criterionSatisfied", "reviewEvidence", "completionVerified", "nextPrompt", "currentInput", "currentRoundStartedAt", "totalElapsedMs", "lastOutput", "history", "createdAt", "updatedAt", "launchGranted"],
    additionalProperties: false,
  }
}

const APP_ACCESS = { "openai/widgetAccessible": true } as const
const MODEL_META = {
  ...APP_ACCESS,
  ui: { resourceUri: MAESTRO_V4_WIDGET_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": MAESTRO_V4_WIDGET_URI,
} as const

export const MAESTRO_V4_TOOLS = [
  {
    name: "maestro_create_task",
    title: "Run a new Maestro task",
    description: "Create a new durable Maestro task for the authenticated user. Use this for a new @My che che. task created inside ChatGPT. The attached Runner starts the first worker turn. Never ask the user for a code, token, task id, or relay value.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", minLength: 1, maxLength: V4_MAX_OBJECTIVE },
        successCriterion: { type: "string", minLength: 1, maxLength: V4_MAX_OBJECTIVE },
        hardRules: { type: "array", items: { type: "string" }, maxItems: V4_MAX_LIST },
        maxRounds: { type: "integer", minimum: 2, maximum: 100_000, default: 10_000 },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    outputSchema: stateSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: { ...MODEL_META, "openai/toolInvocation/invoking": "Starting Maestro task…", "openai/toolInvocation/invoked": "Maestro task started" },
  },
  {
    name: "maestro_begin",
    title: "Begin queued My Chat task",
    description: "Start the newest queued Maestro task created in My Chat for the authenticated user. Takes no arguments. Call once, then end the current turn; the Runner starts the first worker turn. Never ask the user for any code, token, task id, or relay value.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: stateSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...MODEL_META, "openai/toolInvocation/invoking": "Starting queued Maestro task…", "openai/toolInvocation/invoked": "Queued Maestro task started" },
  },
  {
    name: "maestro_round_gate",
    title: "Maestro round gate",
    description: "Persist the end-of-round checkpoint and decide continue/review/finish against the immutable success criterion. Work never finishes. Independent review finishes only with criterionSatisfied=true, non-empty reviewEvidence, no unresolved work, and a complete finalAnswer. Runtime/tool/time/token/round limits never count as completion.",
    inputSchema: {
      type: "object",
      properties: {
        taskToken: { type: "string", minLength: 32, maxLength: V4_MAX_TOKEN },
        round: { type: "integer", minimum: 1, maximum: V4_MAX_ROUND },
        phase: { type: "string", enum: ["work", "review"] },
        checkpoint: { type: "string" },
        unresolved: { type: "array", items: { type: "string" }, maxItems: V4_MAX_LIST },
        nextActions: { type: "array", items: { type: "string" }, maxItems: V4_MAX_LIST },
        evidence: { type: "array", items: { type: "string" }, maxItems: V4_MAX_LIST },
        roundOutput: { type: "string" },
        finalAnswer: { type: "string" },
        done: { type: "boolean" },
        criterionSatisfied: { type: "boolean" },
        reviewEvidence: { type: "array", items: { type: "string" }, maxItems: V4_MAX_LIST },
      },
      required: ["taskToken", "round", "phase", "checkpoint", "unresolved", "nextActions", "evidence", "roundOutput", "finalAnswer", "done", "criterionSatisfied", "reviewEvidence"],
      additionalProperties: false,
    },
    outputSchema: stateSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...MODEL_META, "openai/toolInvocation/invoking": "Saving Maestro round…", "openai/toolInvocation/invoked": "Maestro round saved" },
  },
  {
    name: "maestro_sync",
    title: "Synchronize Maestro Runner",
    description: "Runner-only synchronization and atomic next-round claim using the internal task capability.",
    inputSchema: {
      type: "object",
      properties: { taskToken: { type: "string", minLength: 32, maxLength: V4_MAX_TOKEN } },
      required: ["taskToken"],
      additionalProperties: false,
    },
    outputSchema: stateSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...APP_ACCESS, ui: { visibility: ["app"] } },
  },
] as const
