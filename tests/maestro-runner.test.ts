import test from "node:test"
import assert from "node:assert/strict"
import { MAESTRO_TOOLS, evaluateMaestroGate, handleMaestroRpc } from "../lib/maestro/mcp"
import { MAESTRO_WIDGET_HTML, MAESTRO_WIDGET_URI } from "../lib/maestro/widget"
import { issueMaestroReportToken, maestroStateHash, verifyMaestroReportToken } from "../lib/maestro/tokens"
import { clientMaestroTask, MAESTRO_BRANCH, MAESTRO_META_KIND, type AgentTaskRow } from "../lib/maestro/store"

process.env.MAESTRO_RUNNER_KEY = "test-maestro-runner-key-0123456789-abcdefghijklmnopqrstuvwxyz"

const INTERNAL_START_CODE = "abcdefghijklmnopqrstuvwx"

function meta(overrides: Record<string, unknown> = {}) {
  return {
    kind: MAESTRO_META_KIND,
    version: 1,
    startCode: INTERNAL_START_CODE,
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
    ...overrides,
  }
}

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
    meta: meta(),
    agent_branch: null,
    pull_request_url: null,
    pull_request_number: null,
    commit_sha: null,
    ...overrides,
  }
}

test("Maestro exposes automatic creation, sync/start, and round gate", async () => {
  assert.deepEqual(MAESTRO_TOOLS.map(tool => tool.name), [
    "maestro_create_task",
    "maestro_start",
    "maestro_round_gate",
  ])
  assert.equal(MAESTRO_TOOLS[0].annotations.readOnlyHint, false)
  assert.equal(MAESTRO_TOOLS[1].annotations.readOnlyHint, false)
  assert.equal(MAESTRO_TOOLS[2].annotations.readOnlyHint, false)
  assert.equal(MAESTRO_TOOLS[1]._meta["openai/widgetAccessible"], true)

  const initialized = await handleMaestroRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { origin: "https://example.com" })
  const initResult = initialized?.result as { capabilities: unknown; instructions: string }
  assert.deepEqual(initResult.capabilities, { tools: {}, resources: {} })
  assert.match(initResult.instructions, /maestro_create_task/)
  assert.match(initResult.instructions, /Never ask the user for a start code/)
  assert.match(initResult.instructions, /visible input\/output/)
  assert.match(initResult.instructions, /maestro_start/)

  const listed = await handleMaestroRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { origin: "https://example.com" })
  const tools = (listed?.result as { tools: typeof MAESTRO_TOOLS }).tools
  assert.deepEqual(tools.map(tool => tool.name), MAESTRO_TOOLS.map(tool => tool.name))
})

test("Maestro widget polls through maestro_start and never uses network fetch", async () => {
  assert.match(MAESTRO_WIDGET_HTML, /sendFollowUpMessage/)
  assert.match(MAESTRO_WIDGET_HTML, /callTool\("maestro_start"/)
  assert.match(MAESTRO_WIDGET_HTML, /累计推理墙钟/)
  assert.match(MAESTRO_WIDGET_HTML, /本轮输入/)
  assert.match(MAESTRO_WIDGET_HTML, /本轮输出/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /maestro_status/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /maestro_round_started/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /fetch\s*\(/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /document\.querySelector/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /chat\.openai\.com\/backend-api/)

  const response = await handleMaestroRpc({
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: MAESTRO_WIDGET_URI },
  }, { origin: "https://mychat.example" })
  const content = (response?.result as { contents: Array<{ uri: string; text: string; _meta?: unknown }> }).contents[0]
  assert.equal(content.uri, MAESTRO_WIDGET_URI)
  assert.match(content.text, /maestro_start/)
})

test("public My Chat task projection never contains the internal start code", () => {
  const task = clientMaestroTask(row())
  assert.ok(task)
  assert.equal("startCode" in task, false)
  assert.equal(JSON.stringify(task).includes(INTERNAL_START_CODE), false)
})

test("unfinished work produces the next input without exposing the internal code", () => {
  const state = evaluateMaestroGate(row(), {
    startCode: INTERNAL_START_CODE,
    round: 1,
    phase: "work",
    checkpoint: "Reduced the problem to one missing lemma.",
    unresolved: ["Lemma B"],
    nextActions: ["Prove Lemma B"],
    evidence: ["Lemma A verified"],
    roundOutput: "Established Lemma A and reduced the task to Lemma B.",
    finalAnswer: "",
    done: false,
  })
  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.round, 1)
  assert.equal(state.startCode, INTERNAL_START_CODE)
  assert.match(state.nextPrompt, /第 2 轮/)
  assert.match(state.nextPrompt, /Lemma B/)
  assert.match(state.nextPrompt, /roundOutput/)
  assert.match(state.nextPrompt, /绝对不要向用户索取/)
  assert.doesNotMatch(state.nextPrompt, new RegExp(INTERNAL_START_CODE))
  assert.equal(state.launchGranted, false)
})

test("a candidate answer must go through a separate review turn", () => {
  const state = evaluateMaestroGate(row(), {
    startCode: INTERNAL_START_CODE,
    round: 1,
    phase: "work",
    checkpoint: "All requested work appears complete.",
    unresolved: [],
    nextActions: [],
    evidence: ["All cases checked"],
    roundOutput: "Candidate answer produced.",
    finalAnswer: "Candidate answer",
    done: true,
  })
  assert.equal(state.action, "review")
  assert.equal(state.phase, "review")
  assert.equal(state.finalAnswer, "")
  assert.equal(state.candidateAnswer, "Candidate answer")
  assert.match(state.nextPrompt, /独立复核/)
  assert.doesNotMatch(state.nextPrompt, new RegExp(INTERNAL_START_CODE))
})

test("only a clean review turn can finish the Maestro task", () => {
  const previous = row({
    meta: meta({
      round: 1,
      phase: "review",
      checkpoint: "Candidate produced",
      evidence: ["candidate evidence"],
      candidateAnswer: "Candidate answer",
      lastAction: "review",
      lastReportedAt: "2026-08-24T00:01:00.000Z",
      totalElapsedMs: 60000,
      lastOutput: "Candidate answer",
      history: [{
        round: 1,
        phase: "work",
        input: "Work input",
        output: "Candidate answer",
        checkpoint: "Candidate produced",
        action: "review",
        startedAt: "2026-08-24T00:00:00.000Z",
        finishedAt: "2026-08-24T00:01:00.000Z",
        elapsedMs: 60000,
      }],
    }),
  })
  const state = evaluateMaestroGate(previous, {
    startCode: INTERNAL_START_CODE,
    round: 2,
    phase: "review",
    checkpoint: "Independent review found no material gap.",
    unresolved: [],
    nextActions: [],
    evidence: ["review verified every requirement"],
    roundOutput: "Independent review accepted the candidate.",
    finalAnswer: "Reviewed final answer",
    done: true,
  })
  assert.equal(state.action, "finish")
  assert.equal(state.phase, "done")
  assert.equal(state.finalAnswer, "Reviewed final answer")
  assert.equal(state.nextPrompt, "")
})

test("signed legacy widget report tokens still bind exact task state", () => {
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
