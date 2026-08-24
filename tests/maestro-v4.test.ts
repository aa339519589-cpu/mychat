import test from "node:test"
import assert from "node:assert/strict"
import { evaluateMaestroV4Gate } from "../lib/maestro/v4-engine"
import {
  handleMaestroV4Rpc,
  MAESTRO_V4_SERVER_NAME,
  MAESTRO_V4_SERVER_VERSION,
  MAESTRO_V4_TOOLS,
} from "../lib/maestro/v4"
import { MAESTRO_V4_WIDGET_HTML, MAESTRO_V4_WIDGET_URI } from "../lib/maestro/widget-v4"
import { MAESTRO_BRANCH, MAESTRO_META_KIND, type AgentTaskRow } from "../lib/maestro/store"

function row(overrides: Partial<AgentTaskRow> = {}): AgentTaskRow {
  const now = "2026-08-24T00:00:00.000Z"
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    goal: "Solve the target exactly",
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
      successCriterion: "Produce a rigorous proof of the exact target",
      hardRules: [],
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

test("v4 advertises zero-code begin and no legacy start tool", async () => {
  assert.deepEqual(MAESTRO_V4_TOOLS.map(tool => tool.name), [
    "maestro_create_task",
    "maestro_begin",
    "maestro_round_gate",
    "maestro_sync",
  ])
  const serialized = JSON.stringify(MAESTRO_V4_TOOLS)
  assert.doesNotMatch(serialized, /maestro_start|startCode|启动码/)
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
  }
  assert.equal(result.serverInfo.name, MAESTRO_V4_SERVER_NAME)
  assert.equal(result.serverInfo.version, MAESTRO_V4_SERVER_VERSION)
  assert.match(result.instructions, /maestro_begin/)
  assert.doesNotMatch(result.instructions, /maestro_start|startCode|启动码/)
})

test("v4 resource is fresh and widget continues only through app-only sync", async () => {
  assert.equal(MAESTRO_V4_WIDGET_URI, "ui://maestro-runner/v4-zero-code.html")
  assert.match(MAESTRO_V4_WIDGET_HTML, /callTool\("maestro_sync"/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /sendFollowUpMessage/)
  assert.match(MAESTRO_V4_WIDGET_HTML, /launchGranted/)
  assert.doesNotMatch(MAESTRO_V4_WIDGET_HTML, /maestro_start|startCode|启动码/)
  assert.doesNotMatch(MAESTRO_V4_WIDGET_HTML, /fetch\s*\(/)
  assert.doesNotMatch(MAESTRO_V4_WIDGET_HTML, /querySelector|backend-api/)

  const response = await handleMaestroV4Rpc(
    { jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: MAESTRO_V4_WIDGET_URI } },
    { origin: "https://example.com", userId: "user-a" },
  )
  const contents = (response?.result as { contents: Array<{ uri: string }> }).contents
  assert.equal(contents[0].uri, MAESTRO_V4_WIDGET_URI)
})

test("v4 unfinished work cannot stop", () => {
  const state = evaluateMaestroV4Gate(row(), {
    round: 1,
    phase: "work",
    checkpoint: "Reduced to one missing lemma",
    unresolved: ["Lemma B"],
    nextActions: ["Prove Lemma B"],
    evidence: ["Lemma A checked"],
    finalAnswer: "",
    done: false,
    criterionSatisfied: false,
    reviewEvidence: [],
  }, "internal-task-token")

  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.completionVerified, false)
  assert.match(state.nextPrompt, /不可变成功判据/)
  assert.match(state.nextPrompt, /第 2 轮/)
})

test("v4 work closure only creates independent review", () => {
  const state = evaluateMaestroV4Gate(row(), {
    round: 1,
    phase: "work",
    checkpoint: "Candidate complete",
    unresolved: [],
    nextActions: [],
    evidence: ["all work cases checked"],
    finalAnswer: "Candidate answer",
    done: true,
    criterionSatisfied: false,
    reviewEvidence: [],
  }, "internal-task-token")

  assert.equal(state.action, "review")
  assert.equal(state.phase, "review")
  assert.equal(state.finalAnswer, "")
  assert.equal(state.candidateAnswer, "Candidate answer")
  assert.equal(state.completionVerified, false)
})

test("v4 rejected review returns to work instead of pretending success", () => {
  const previous = row({
    meta: {
      kind: MAESTRO_META_KIND,
      version: 1,
      maxRounds: 100,
      round: 1,
      phase: "review",
      successCriterion: "Produce a rigorous proof of the exact target",
      hardRules: [],
      checkpoint: "Candidate ready",
      unresolved: [],
      nextActions: [],
      evidence: ["candidate evidence"],
      candidateAnswer: "Candidate answer",
      finalAnswer: "",
      criterionSatisfied: false,
      reviewEvidence: [],
      completionVerified: false,
      lastAction: "review",
      lastReportedAt: "2026-08-24T00:01:00.000Z",
      currentInput: "Review candidate",
      currentRoundStartedAt: "2026-08-24T00:01:10.000Z",
      totalElapsedMs: 10000,
      lastOutput: "Candidate answer",
      history: [],
    },
  })

  const state = evaluateMaestroV4Gate(previous, {
    round: 2,
    phase: "review",
    checkpoint: "Review found a gap",
    unresolved: [],
    nextActions: [],
    evidence: ["gap found"],
    finalAnswer: "",
    done: false,
    criterionSatisfied: false,
    reviewEvidence: ["Missing justification in Lemma B"],
  }, "internal-task-token")

  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.completionVerified, false)
  assert.ok(state.unresolved.length > 0)
  assert.ok(state.nextActions.length > 0)
})

test("v4 only verified independent review can finish", () => {
  const previous = row({
    meta: {
      kind: MAESTRO_META_KIND,
      version: 1,
      maxRounds: 100,
      round: 1,
      phase: "review",
      successCriterion: "Produce a rigorous proof of the exact target",
      hardRules: [],
      checkpoint: "Candidate ready",
      unresolved: [],
      nextActions: [],
      evidence: ["candidate evidence"],
      candidateAnswer: "Candidate answer",
      finalAnswer: "",
      criterionSatisfied: false,
      reviewEvidence: [],
      completionVerified: false,
      lastAction: "review",
      lastReportedAt: "2026-08-24T00:01:00.000Z",
      currentInput: "Review candidate",
      currentRoundStartedAt: "2026-08-24T00:01:10.000Z",
      totalElapsedMs: 10000,
      lastOutput: "Candidate answer",
      history: [],
    },
  })

  const state = evaluateMaestroV4Gate(previous, {
    round: 2,
    phase: "review",
    checkpoint: "Review verified every required step",
    unresolved: [],
    nextActions: [],
    evidence: ["all proof obligations checked"],
    finalAnswer: "Reviewed final answer",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: ["Every proof obligation was independently checked"],
  }, "internal-task-token")

  assert.equal(state.action, "finish")
  assert.equal(state.phase, "done")
  assert.equal(state.completionVerified, true)
  assert.equal(state.criterionSatisfied, true)
  assert.equal(state.finalAnswer, "Reviewed final answer")
  assert.equal(state.nextPrompt, "")
})
