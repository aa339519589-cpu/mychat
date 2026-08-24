import { MAESTRO_WIDGET_URI } from "@/lib/maestro/widget"

export const MAX_LIST = 64
export const MAX_OBJECTIVE = 100_000
export const MAX_TOKEN = 4_096

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
      taskToken: { type: "string", description: "Internal Maestro capability. Never request or display it to the user." },
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
    required: ["kind", "jobId", "taskToken", "objective", "status", "round", "phase", "action", "checkpoint", "unresolved", "nextActions", "evidence", "candidateAnswer", "finalAnswer", "nextPrompt", "currentInput", "currentRoundStartedAt", "totalElapsedMs", "lastOutput", "history", "createdAt", "updatedAt", "launchGranted"],
    additionalProperties: false,
  }
}

const WIDGET_ACCESSIBLE = { "openai/widgetAccessible": true } as const
const SHARED_META = {
  ...WIDGET_ACCESSIBLE,
  ui: { resourceUri: MAESTRO_WIDGET_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": MAESTRO_WIDGET_URI,
} as const

export const MAESTRO_TOOLS = [
  {
    name: "maestro_create_task",
    title: "Run a new Maestro task",
    description: "Create and immediately start a new Maestro Runner task from the user's objective. Always use this for @My che che. followed by a new task. Never ask the user for any code, token, task id, or relay value.",
    inputSchema: {
      type: "object",
      properties: {
        objective: { type: "string", minLength: 1, maxLength: MAX_OBJECTIVE },
        maxRounds: { type: "integer", minimum: 2, maximum: 100_000, default: 10_000 },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    _meta: { ...SHARED_META, "openai/toolInvocation/invoking": "Starting Maestro task…", "openai/toolInvocation/invoked": "Maestro task started" },
  },
  {
    name: "maestro_begin",
    title: "Begin queued My Chat task",
    description: "Start the newest queued Maestro task created by My Chat. This tool takes no arguments. Call it immediately for a My Chat-launched task. Never ask the user for any code, token, task id, or relay value.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...SHARED_META, "openai/toolInvocation/invoking": "Starting queued Maestro task…", "openai/toolInvocation/invoked": "Queued Maestro task started" },
  },
  {
    name: "maestro_round_gate",
    title: "Maestro round gate",
    description: "Persist and evaluate the checkpoint at the end of every worker/review turn. Reuse taskToken from the latest internal Maestro state automatically. Never ask the user for relay values. Include roundOutput as the user-visible work product for this round.",
    inputSchema: {
      type: "object",
      properties: {
        taskToken: { type: "string", minLength: 32, maxLength: MAX_TOKEN },
        round: { type: "integer", minimum: 1, maximum: 1_000_000 },
        phase: { type: "string", enum: ["work", "review"] },
        checkpoint: { type: "string" },
        unresolved: { type: "array", items: { type: "string" }, maxItems: MAX_LIST },
        nextActions: { type: "array", items: { type: "string" }, maxItems: MAX_LIST },
        evidence: { type: "array", items: { type: "string" }, maxItems: MAX_LIST },
        roundOutput: { type: "string" },
        finalAnswer: { type: "string" },
        done: { type: "boolean" },
      },
      required: ["taskToken", "round", "phase", "checkpoint", "unresolved", "nextActions", "evidence", "roundOutput", "finalAnswer", "done"],
      additionalProperties: false,
    },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...SHARED_META, "openai/toolInvocation/invoking": "Saving Maestro round…", "openai/toolInvocation/invoked": "Maestro round saved" },
  },
  {
    name: "maestro_sync",
    title: "Synchronize Maestro runner",
    description: "Widget-only synchronization and next-round claim using the internal task capability.",
    inputSchema: {
      type: "object",
      properties: { taskToken: { type: "string", minLength: 32, maxLength: MAX_TOKEN } },
      required: ["taskToken"],
      additionalProperties: false,
    },
    outputSchema: stateOutputSchema(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    _meta: { ...WIDGET_ACCESSIBLE, ui: { visibility: ["app"] } },
  },
] as const
