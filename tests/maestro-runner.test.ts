import test from "node:test"
import assert from "node:assert/strict"
import { MAESTRO_TOOLS, evaluateMaestroGate, handleMaestroRpc } from "../lib/maestro/mcp"
import { MAESTRO_WIDGET_HTML, MAESTRO_WIDGET_URI } from "../lib/maestro/widget"
import {
  issueMaestroLaunchToken,
  issueMaestroReportToken,
  issueMaestroTaskToken,
  maestroStateHash,
  verifyMaestroLaunchToken,
  verifyMaestroReportToken,
  verifyMaestroTaskToken,
} from "../lib/maestro/tokens"
import { MAESTRO_BRANCH, MAESTRO_META_KIND, type AgentTaskRow } from "../lib/maestro/store"

process.env.MAESTRO_RUNNER_KEY = "test-maestro-runner-key-0123456789-abcdefghijklmnopqrstuvwxyz"

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
    },
    agent_branch: null,
    pull_request_url: null,
    pull_request_number: null,
    commit_sha: null,
    ...overrides,
  }
}

test("Maestro MCP exposes direct-launch tools without any startCode field", async () => {
  assert.deepEqual(MAESTRO_TOOLS.map(tool => tool.name), ["maestro_start", "maestro_round_gate"])
  assert.ok(MAESTRO_TOOLS.every(tool => tool.annotations.readOnlyHint === true))
  assert.ok(MAESTRO_TOOLS.every(tool => tool._meta["openai/outputTemplate"] === MAESTRO_WIDGET_URI))
  const toolJson = JSON.stringify(MAESTRO_TOOLS)
  assert.doesNotMatch(toolJson, /startCode/)
  assert.match(toolJson, /never ask the user/i)

  const initialized = await handleMaestroRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { origin: "https://example.com" })
  const initResult = initialized?.result as Record<string, unknown>
  assert.deepEqual(initResult.capabilities, { tools: {}, resources: {} })
  assert.doesNotMatch(String(initResult.instructions), /supplied start code/i)
  assert.match(String(initResult.instructions), /Never ask the user/i)

  const listed = await handleMaestroRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { origin: "https://example.com" })
  const tools = (listed?.result as { tools: typeof MAESTRO_TOOLS }).tools
  assert.deepEqual(tools.map(tool => tool.name), ["maestro_start", "maestro_round_gate"])
})

test("Maestro widget uses the supported follow-up bridge and never scrapes ChatGPT DOM", async () => {
  assert.match(MAESTRO_WIDGET_HTML, /sendFollowUpMessage/)
  assert.match(MAESTRO_WIDGET_HTML, /ui\/notifications\/tool-result/)
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
  assert.match(content.text, /sendFollowUpMessage/)
})

test("unfinished work always becomes another work turn", () => {
  const state = evaluateMaestroGate(row(), {
    round: 1,
    phase: "work",
    checkpoint: "Reduced the problem to one missing lemma.",
    unresolved: ["Lemma B"],
    nextActions: ["Prove Lemma B"],
    evidence: ["Lemma A verified"],
    finalAnswer: "",
    done: false,
  }, "task-token")
  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.round, 1)
  assert.equal(state.taskToken, "task-token")
  assert.match(state.nextPrompt, /第 2 轮/)
  assert.match(state.nextPrompt, /Lemma B/)
  assert.doesNotMatch(state.nextPrompt, /启动码/)
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
  }, "task-token")
  assert.equal(state.action, "review")
  assert.equal(state.phase, "review")
  assert.equal(state.finalAnswer, "")
  assert.equal(state.candidateAnswer, "Candidate answer")
  assert.match(state.nextPrompt, /独立复核/)
})

test("only a clean review turn can finish the Maestro task", () => {
  const previous = row({
    meta: {
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
    },
  })
  const state = evaluateMaestroGate(previous, {
    round: 2,
    phase: "review",
    checkpoint: "Independent review found no material gap.",
    unresolved: [],
    nextActions: [],
    evidence: ["review verified every requirement"],
    finalAnswer: "Reviewed final answer",
    done: true,
  }, "task-token-2")
  assert.equal(state.action, "finish")
  assert.equal(state.phase, "done")
  assert.equal(state.finalAnswer, "Reviewed final answer")
  assert.equal(state.nextPrompt, "")
})

test("launch and task capabilities are signed and bound to one My Chat task", () => {
  const launchToken = issueMaestroLaunchToken({ userId: "user-a", jobId: "job-a" })
  const launch = verifyMaestroLaunchToken(launchToken)
  assert.equal(launch?.userId, "user-a")
  assert.equal(launch?.jobId, "job-a")
  assert.equal(verifyMaestroLaunchToken(`${launchToken}x`), null)

  const taskToken = issueMaestroTaskToken({ userId: "user-a", jobId: "job-a" })
  const task = verifyMaestroTaskToken(taskToken)
  assert.equal(task?.userId, "user-a")
  assert.equal(task?.jobId, "job-a")
  assert.equal(verifyMaestroTaskToken(`${taskToken}x`), null)
})

test("signed widget report tokens bind the exact task, round and structured state", () => {
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
