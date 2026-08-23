import test from "node:test"
import assert from "node:assert/strict"
import { MAESTRO_TOOLS, evaluateMaestroGate, handleMaestroRpc } from "../lib/maestro/mcp"
import { MAESTRO_WIDGET_HTML, MAESTRO_WIDGET_URI } from "../lib/maestro/widget"
import { issueMaestroReportToken, issueMaestroTaskToken, maestroStateHash, verifyMaestroReportToken, verifyMaestroTaskToken } from "../lib/maestro/tokens"
import { MAESTRO_BRANCH, MAESTRO_META_KIND, type AgentTaskRow } from "../lib/maestro/store"

process.env.MAESTRO_RUNNER_KEY = "test-maestro-runner-key-0123456789-abcdefghijklmnopqrstuvwxyz"
const INTERNAL_TASK_TOKEN = "internal-task-capability"

function row(overrides: Partial<AgentTaskRow> = {}): AgentTaskRow {
  const now = "2026-08-24T00:00:00.000Z"
  return {
    id: "00000000-0000-4000-8000-000000000001",
    user_id: "00000000-0000-4000-8000-000000000002",
    goal: "Solve a difficult problem completely",
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
      checkpoint: "",
      unresolved: [],
      nextActions: [],
      evidence: [],
      candidateAnswer: "",
      finalAnswer: "",
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

test("Maestro exposes automatic creation, zero-argument My Chat start, and no startCode schema", async () => {
  assert.deepEqual(MAESTRO_TOOLS.map(tool => tool.name), ["maestro_create_task", "maestro_start", "maestro_round_gate", "maestro_status", "maestro_round_started"])
  assert.equal(MAESTRO_TOOLS[0].annotations.readOnlyHint, false)
  assert.equal(MAESTRO_TOOLS[1].annotations.readOnlyHint, true)
  assert.equal(MAESTRO_TOOLS[2].annotations.readOnlyHint, false)
  assert.doesNotMatch(JSON.stringify(MAESTRO_TOOLS), /startCode/)
  assert.deepEqual(MAESTRO_TOOLS[1].inputSchema, { type: "object", properties: {}, additionalProperties: false })
  assert.ok(MAESTRO_TOOLS.slice(0, 3).every(tool => tool._meta["openai/outputTemplate"] === MAESTRO_WIDGET_URI))

  const initialized = await handleMaestroRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { origin: "https://example.com" })
  const initResult = initialized?.result as { capabilities: unknown; instructions: string }
  assert.deepEqual(initResult.capabilities, { tools: {}, resources: {} })
  assert.match(initResult.instructions, /maestro_create_task/)
  assert.match(initResult.instructions, /zero-argument maestro_start/)
  assert.doesNotMatch(initResult.instructions, /startCode/)
})

test("Maestro widget only sends follow-up messages and performs no network sync fetch", async () => {
  assert.match(MAESTRO_WIDGET_HTML, /sendFollowUpMessage/)
  assert.match(MAESTRO_WIDGET_HTML, /ui\/notifications\/tool-result/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /fetch\s*\(/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /document\.querySelector/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /chat\.openai\.com\/backend-api/)

  const response = await handleMaestroRpc({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: MAESTRO_WIDGET_URI } }, { origin: "https://mychat.example" })
  const content = (response?.result as { contents: Array<{ uri: string; text: string }> }).contents[0]
  assert.equal(content.uri, MAESTRO_WIDGET_URI)
  assert.match(content.text, /sendFollowUpMessage/)
})

test("unfinished work becomes another work turn without relay instructions and keeps telemetry", () => {
  const state = evaluateMaestroGate(row(), {
    round: 1,
    phase: "work",
    checkpoint: "Reduced the problem to one missing lemma.",
    unresolved: ["Lemma B"],
    nextActions: ["Prove Lemma B"],
    evidence: ["Lemma A verified"],
    finalAnswer: "",
    done: false,
  }, INTERNAL_TASK_TOKEN)
  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.round, 1)
  assert.equal(state.taskToken, INTERNAL_TASK_TOKEN)
  assert.equal(state.totalElapsedMs, 0)
  assert.deepEqual(state.history, [])
  assert.match(state.nextPrompt, /第 2 轮/)
  assert.match(state.nextPrompt, /roundOutput/)
  assert.match(state.nextPrompt, /Lemma B/)
  assert.doesNotMatch(state.nextPrompt, /启动码|startCode|taskToken|任务 ID|中转/)
})

test("a candidate answer must go through a separate review turn", () => {
  const state = evaluateMaestroGate(row(), {
    round: 1,
    phase: "work",
    checkpoint: "All requested work appears complete.",
    unresolved: [],
    nextActions: [],
    evidence: ["All cases checked"],
    finalAnswer: "Candidate answer",
    done: true,
  }, INTERNAL_TASK_TOKEN)
  assert.equal(state.action, "review")
  assert.equal(state.phase, "review")
  assert.equal(state.finalAnswer, "")
  assert.equal(state.candidateAnswer, "Candidate answer")
  assert.match(state.nextPrompt, /独立复核/)
})

test("only a clean review turn can finish the Maestro task", () => {
  const previous = row({ meta: {
    kind: MAESTRO_META_KIND,
    version: 1,
    maxRounds: 100,
    round: 1,
    phase: "review",
    checkpoint: "Candidate produced",
    unresolved: [],
    nextActions: [],
    evidence: ["candidate evidence"],
    candidateAnswer: "Candidate answer",
    finalAnswer: "",
    lastAction: "review",
    lastReportedAt: "2026-08-24T00:01:00.000Z",
    currentInput: "review candidate",
    currentRoundStartedAt: "2026-08-24T00:01:10.000Z",
    totalElapsedMs: 10000,
    lastOutput: "Candidate answer",
    history: [],
  } })
  const state = evaluateMaestroGate(previous, {
    round: 2,
    phase: "review",
    checkpoint: "Independent review found no material gap.",
    unresolved: [],
    nextActions: [],
    evidence: ["review verified every requirement"],
    finalAnswer: "Reviewed final answer",
    done: true,
  }, INTERNAL_TASK_TOKEN)
  assert.equal(state.action, "finish")
  assert.equal(state.phase, "done")
  assert.equal(state.finalAnswer, "Reviewed final answer")
  assert.equal(state.nextPrompt, "")
  assert.equal(state.totalElapsedMs, 10000)
})

test("internal task capability is signed and bound to one task", () => {
  const token = issueMaestroTaskToken({ userId: "user-a", jobId: "job-a" })
  const verified = verifyMaestroTaskToken(token)
  assert.equal(verified?.userId, "user-a")
  assert.equal(verified?.jobId, "job-a")
  assert.equal(verifyMaestroTaskToken(`${token}x`), null)
})

test("signed legacy widget report tokens still bind exact task, round and state", () => {
  const state = { jobId: "job-a", round: 7, phase: "work", action: "continue" }
  const stateHash = maestroStateHash(state)
  const token = issueMaestroReportToken({ userId: "user-a", jobId: "job-a", round: 7, stateHash })
  const verified = verifyMaestroReportToken(token)
  assert.equal(verified?.userId, "user-a")
  assert.equal(verified?.jobId, "job-a")
  assert.equal(verified?.round, 7)
  assert.equal(verified?.stateHash, stateHash)
  assert.equal(verifyMaestroReportToken(`${token}x`), null)
})
