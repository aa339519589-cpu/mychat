import test from "node:test"
import assert from "node:assert/strict"
import { evaluateMaestroV4Gate } from "../lib/maestro/v4-engine"
import { maestroV4Prompt } from "../lib/maestro/v4-prompts"
import {
  handleMaestroV4Rpc,
  MAESTRO_V4_SERVER_NAME,
  MAESTRO_V4_SERVER_VERSION,
  MAESTRO_V4_TOOLS,
} from "../lib/maestro/v4"
import { MAESTRO_V4_WIDGET_HTML, MAESTRO_V4_WIDGET_URI } from "../lib/maestro/widget-v4"
import {
  MAESTRO_BRANCH,
  MAESTRO_BUILTIN_HARD_RULES,
  MAESTRO_META_KIND,
  type AgentTaskRow,
} from "../lib/maestro/store"

const CRITERION = "Prove unconditionally that kappa > 0.75"
const TOKEN = "internal-v4-task-token"

function row(overrides: Partial<AgentTaskRow> = {}): AgentTaskRow {
  const now = "2026-08-24T00:00:00.000Z"
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    goal: "Raise the unconditional lower bound to kappa > 0.75",
    mode: "plan",
    repo: null,
    branch: MAESTRO_BRANCH,
    status: "running",
    error: null,
    created_at: now,
    updated_at: now,
    started_at: now,
    finished_at: null,
    meta: {
      kind: MAESTRO_META_KIND,
      version: 1,
      maxRounds: 100,
      round: 0,
      phase: "work",
      successCriterion: CRITERION,
      hardRules: [...MAESTRO_BUILTIN_HARD_RULES],
      checkpoint: "",
      unresolved: [],
      nextActions: [],
      evidence: [],
      candidateAnswer: "",
      finalAnswer: "",
      criterionSatisfied: false,
      reviewEvidence: [],
      completionVerified: false,
      lastAction: "queued",
      lastReportedAt: null,
      currentInput: "",
      currentRoundStartedAt: null,
      totalElapsedMs: 0,
      lastOutput: "",
      history: [],
    },
    agent_branch: null,
    pull_request_url: null,
    pull_request_number: null,
    commit_sha: null,
    ...overrides,
  }
}

function rowWithMeta(metaOverrides: Record<string, unknown>): AgentTaskRow {
  const base = row()
  return row({
    meta: {
      ...(base.meta as Record<string, unknown>),
      ...metaOverrides,
    } as AgentTaskRow["meta"],
  })
}

function gateBase() {
  return {
    checkpoint: "checkpoint",
    unresolved: [] as string[],
    nextActions: [] as string[],
    evidence: ["evidence"],
    finalAnswer: "",
    done: false,
    criterionSatisfied: false,
    reviewEvidence: [] as string[],
  }
}

test("v4 advertises zero-code model entry points and app-only synchronization", async () => {
  assert.deepEqual(MAESTRO_V4_TOOLS.map(tool => tool.name), [
    "maestro_create_task",
    "maestro_begin",
    "maestro_round_gate",
    "maestro_sync",
  ])
  const serialized = JSON.stringify(MAESTRO_V4_TOOLS)
  assert.doesNotMatch(serialized, /maestro_start|startCode|启动码/)
  assert.match(serialized, /Never ask the user for a code/)
  assert.deepEqual(MAESTRO_V4_TOOLS[1].inputSchema, {
    type: "object",
    properties: {},
    additionalProperties: false,
  })
  assert.deepEqual(MAESTRO_V4_TOOLS[3]._meta.ui.visibility, ["app"])

  const initialized = await handleMaestroV4Rpc(
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { origin: "https://example.com", userId: "user-a" },
  )
  const result = initialized?.result as {
    serverInfo: { name: string; version: string }
    instructions: string
    capabilities: unknown
  }
  assert.equal(result.serverInfo.name, MAESTRO_V4_SERVER_NAME)
  assert.equal(result.serverInfo.version, MAESTRO_V4_SERVER_VERSION)
  assert.deepEqual(result.capabilities, { tools: { listChanged: true }, resources: { listChanged: true } })
  assert.match(result.instructions, /maestro_begin/)
  assert.match(result.instructions, /Only a separate independent review may finish/)
  assert.match(result.instructions, /never count as completion/)
  assert.doesNotMatch(result.instructions, /maestro_start|startCode|启动码/)
})

test("v4 discovery works without auth but actions require an authenticated My Chat user", async () => {
  const listed = await handleMaestroV4Rpc(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { origin: "https://example.com", userId: null },
  )
  assert.equal(Array.isArray((listed?.result as { tools?: unknown[] })?.tools), true)

  const called = await handleMaestroV4Rpc(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "maestro_begin", arguments: {} } },
    { origin: "https://example.com", userId: null },
  )
  const result = called?.result as { isError?: boolean; content?: Array<{ text?: string }> }
  assert.equal(result.isError, true)
  assert.match(result.content?.[0]?.text ?? "", /authenticated My Chat user/)
})

test("v4 unfinished work cannot stop", () => {
  const state = evaluateMaestroV4Gate(row(), {
    ...gateBase(),
    round: 1,
    phase: "work",
    checkpoint: "Reduced to one missing lemma",
    unresolved: ["Lemma B"],
    nextActions: ["Prove Lemma B"],
  }, TOKEN)

  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.status, "running")
  assert.equal(state.completionVerified, false)
  assert.equal(state.criterionSatisfied, false)
  assert.match(state.nextPrompt, /不可变成功判据/)
  assert.match(state.nextPrompt, /第 2 轮/)
})

test("v4 work closure only creates independent review even if worker claims criterionSatisfied", () => {
  const state = evaluateMaestroV4Gate(row(), {
    ...gateBase(),
    round: 1,
    phase: "work",
    checkpoint: "Candidate complete",
    finalAnswer: "Candidate answer",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: ["worker self-review is not independent"],
  }, TOKEN)

  assert.equal(state.action, "review")
  assert.equal(state.phase, "review")
  assert.equal(state.status, "running")
  assert.equal(state.finalAnswer, "")
  assert.equal(state.candidateAnswer, "Candidate answer")
  assert.equal(state.criterionSatisfied, false)
  assert.equal(state.completionVerified, false)
})

test("v4 inability, unknown methods, tool limits, time limits, and no progress can never finish review", () => {
  const previous = rowWithMeta({
    round: 1,
    phase: "review",
    checkpoint: "Candidate says the target cannot currently be proved",
    candidateAnswer: "Unable to prove the exact target with current methods.",
    lastAction: "review",
  })

  const state = evaluateMaestroV4Gate(previous, {
    ...gateBase(),
    round: 2,
    phase: "review",
    checkpoint: "No known route closes the gap; tool and time limits reached.",
    finalAnswer: "Cannot solve with current tools.",
    done: true,
    criterionSatisfied: false,
    reviewEvidence: ["The attempted proof is incomplete"],
  }, TOKEN)

  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.status, "running")
  assert.equal(state.finalAnswer, "")
  assert.equal(state.criterionSatisfied, false)
  assert.equal(state.completionVerified, false)
  assert.ok(state.unresolved.length > 0)
  assert.ok(state.nextActions.length > 0)
})

test("v4 criterionSatisfied=true is still insufficient without independent review evidence", () => {
  const previous = rowWithMeta({
    round: 1,
    phase: "review",
    checkpoint: "Candidate ready",
    candidateAnswer: "Candidate answer",
    lastAction: "review",
  })

  const state = evaluateMaestroV4Gate(previous, {
    ...gateBase(),
    round: 2,
    phase: "review",
    finalAnswer: "Reviewed answer",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: [],
  }, TOKEN)

  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.completionVerified, false)
  assert.equal(state.criterionSatisfied, false)
})

test("v4 only verified independent review can finish", () => {
  const previous = rowWithMeta({
    round: 1,
    phase: "review",
    checkpoint: "Candidate ready",
    candidateAnswer: "Candidate proof",
    lastAction: "review",
  })

  const state = evaluateMaestroV4Gate(previous, {
    ...gateBase(),
    round: 2,
    phase: "review",
    checkpoint: "Review verified every required step and the exact immutable target.",
    evidence: ["all proof obligations checked"],
    finalAnswer: "Reviewed rigorous proof",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: [
      "Every essential inequality was independently checked",
      "The conclusion was checked to be exactly kappa > 0.75",
    ],
  }, TOKEN)

  assert.equal(state.action, "finish")
  assert.equal(state.phase, "done")
  assert.equal(state.status, "completed")
  assert.equal(state.completionVerified, true)
  assert.equal(state.criterionSatisfied, true)
  assert.equal(state.finalAnswer, "Reviewed rigorous proof")
  assert.equal(state.nextPrompt, "")
})

test("v4 initial maxRounds is only a planning horizon and never a completion boundary", () => {
  const beyond = rowWithMeta({ maxRounds: 1, round: 1, phase: "work", checkpoint: "Still unfinished" })
  const state = evaluateMaestroV4Gate(beyond, {
    ...gateBase(),
    round: 2,
    phase: "work",
    unresolved: ["Target not reached"],
    nextActions: ["Continue proving the exact target"],
  }, TOKEN)

  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.completionVerified, false)
  assert.match(state.nextPrompt, /第 3 轮/)
})

test("v4 prompt preserves immutable criterion and explicitly forbids false completion", () => {
  const prompt = maestroV4Prompt({
    objective: "Research the target",
    successCriterion: CRITERION,
    hardRules: [...MAESTRO_BUILTIN_HARD_RULES],
    nextRound: 7,
    phase: "work",
    checkpoint: "checkpoint",
    unresolved: ["missing lemma"],
    nextActions: ["prove lemma"],
    evidence: ["partial result"],
    candidateAnswer: "",
  })

  assert.ok(prompt.includes(CRITERION))
  assert.match(prompt, /不可变成功判据/)
  assert.match(prompt, /耗时、轮数、token\/工具限制、平台中断、没有已知方法、无法解决或缺少进展/)
  assert.match(prompt, /必须保持未完成并继续/)
  assert.match(prompt, /work 轮永远不能直接完成任务/)
})

test("v4 widget exposes full synchronized state and never uses cross-origin fetch", async () => {
  assert.equal(MAESTRO_V4_WIDGET_URI, "ui://maestro-runner/v4-zero-code.html")
  assert.match(MAESTRO_V4_WIDGET_HTML, /callTool\("maestro_sync"/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /sendFollowUpMessage/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /launchGranted/)
  assert.doesNotMatch(MAESTRO_V4_WIDGET_HTML, /maestro_start|startCode|启动码/)
  assert.doesNotMatch(MAESTRO_V4_WIDGET_HTML, /fetch\s*\(/)
  assert.doesNotMatch(MAESTRO_V4_WIDGET_HTML, /querySelector|backend-api/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /不可变成功判据/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /不可变硬规则/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /本轮输入/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /本轮输出/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /本轮墙钟/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /累计推理墙钟/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /独立 Review 证据/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /完成门/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /轮次历史/)

  const response = await handleMaestroV4Rpc(
    { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: MAESTRO_V4_WIDGET_URI } },
    { origin: "https://example.com", userId: "user-a" },
  )
  const contents = (response?.result as { contents: Array<{ uri: string; text: string }> }).contents
  assert.equal(contents[0].uri, MAESTRO_V4_WIDGET_URI)
  assert.match(contents[0].text, /完成门/)
})
