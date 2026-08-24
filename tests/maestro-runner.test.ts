import test from "node:test"
import assert from "node:assert/strict"
import { MAESTRO_TOOLS, evaluateMaestroGate, handleMaestroRpc } from "../lib/maestro/mcp"
import { MAESTRO_WIDGET_HTML, MAESTRO_WIDGET_URI } from "../lib/maestro/widget"
import { issueMaestroTaskToken, verifyMaestroTaskToken } from "../lib/maestro/tokens"
import { clientMaestroTask, MAESTRO_BRANCH, MAESTRO_META_KIND, type AgentTaskRow } from "../lib/maestro/store"

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
      successCriterion: "Solve a difficult problem completely",
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

test("Maestro exposes a fresh zero-argument begin tool and no legacy start tool", async () => {
  assert.deepEqual(MAESTRO_TOOLS.map(tool => tool.name), ["maestro_create_task", "maestro_begin", "maestro_round_gate", "maestro_sync"])
  const serialized = JSON.stringify(MAESTRO_TOOLS)
  assert.doesNotMatch(serialized, /startCode|启动码/)
  assert.doesNotMatch(serialized, /maestro_start/)
  assert.deepEqual(MAESTRO_TOOLS[1].inputSchema, { type: "object", properties: {}, additionalProperties: false })
  assert.deepEqual(MAESTRO_TOOLS[3]._meta.ui.visibility, ["app"])

  const initialized = await handleMaestroRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, { origin: "https://example.com" })
  const result = initialized?.result as { capabilities: unknown; instructions: string; serverInfo: { name: string; version: string } }
  assert.deepEqual(result.capabilities, { tools: { listChanged: true }, resources: { listChanged: true } })
  assert.equal(result.serverInfo.name, "mychat-maestro-runner-v3")
  assert.equal(result.serverInfo.version, "3.0.0")
  assert.match(result.instructions, /maestro_begin/)
  assert.match(result.instructions, /immutable/)
  assert.doesNotMatch(result.instructions, /maestro_start|startCode|启动码/)
})

test("widget synchronizes through app-only maestro_sync and never scrapes ChatGPT", async () => {
  assert.match(MAESTRO_WIDGET_HTML, /sendFollowUpMessage/)
  assert.match(MAESTRO_WIDGET_HTML, /callTool\("maestro_sync"/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /maestro_start|startCode|启动码/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /fetch\s*\(/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /document\.querySelector/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /backend-api/)

  const response = await handleMaestroRpc({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: MAESTRO_WIDGET_URI } }, { origin: "https://example.com" })
  const contents = (response?.result as { contents: Array<{ uri: string; text: string }> }).contents
  assert.equal(contents[0].uri, MAESTRO_WIDGET_URI)
})

test("public My Chat task projection hides internal capability", () => {
  const projected = clientMaestroTask(row())
  assert.ok(projected)
  assert.equal("taskToken" in projected, false)
  assert.equal("startCode" in projected, false)
})

test("unfinished work continues and candidate closure requires separate review", () => {
  const continued = evaluateMaestroGate(row(), {
    round: 1,
    phase: "work",
    checkpoint: "One lemma remains.",
    unresolved: ["Lemma B"],
    nextActions: ["Prove Lemma B"],
    evidence: ["Lemma A checked"],
    finalAnswer: "",
    done: false,
    criterionSatisfied: false,
    reviewEvidence: [],
    completionVerified: false,
  }, "internal-task-token")
  assert.equal(continued.action, "continue")
  assert.equal(continued.phase, "work")
  assert.match(continued.nextPrompt, /第 2 轮/)
  assert.match(continued.nextPrompt, /成功判据/)
  assert.doesNotMatch(continued.nextPrompt, /启动码|startCode|taskToken|任务 ID|中转/)

  const review = evaluateMaestroGate(row(), {
    round: 1,
    phase: "work",
    checkpoint: "All requested work appears complete.",
    unresolved: [],
    nextActions: [],
    evidence: ["All cases checked"],
    finalAnswer: "Candidate answer",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: [],
    completionVerified: false,
  }, "internal-task-token")
  assert.equal(review.action, "review")
  assert.equal(review.phase, "review")
  assert.equal(review.finalAnswer, "")
  assert.equal(review.candidateAnswer, "Candidate answer")
  assert.equal(review.completionVerified, false)
})

test("done cannot bypass an unsatisfied success criterion", () => {
  const state = evaluateMaestroGate(row(), {
    round: 1,
    phase: "work",
    checkpoint: "Model tried to stop early.",
    unresolved: [],
    nextActions: [],
    evidence: [],
    finalAnswer: "Premature answer",
    done: true,
    criterionSatisfied: false,
    reviewEvidence: [],
    completionVerified: false,
  }, "internal-task-token")
  assert.equal(state.action, "continue")
  assert.equal(state.phase, "work")
  assert.equal(state.completionVerified, false)
})

test("only a clean independent review with evidence can finish", () => {
  const previous = row({
    meta: {
      kind: MAESTRO_META_KIND,
      version: 1,
      maxRounds: 100,
      round: 1,
      phase: "review",
      successCriterion: "Solve a difficult problem completely",
      hardRules: [],
      checkpoint: "Candidate produced",
      unresolved: [],
      nextActions: [],
      evidence: ["candidate evidence"],
      candidateAnswer: "Candidate answer",
      finalAnswer: "",
      criterionSatisfied: true,
      reviewEvidence: [],
      completionVerified: false,
      lastAction: "review",
      lastReportedAt: "2026-08-24T00:01:00.000Z",
      currentInput: "review candidate",
      currentRoundStartedAt: "2026-08-24T00:01:10.000Z",
      totalElapsedMs: 10000,
      lastOutput: "Candidate answer",
      history: [],
    },
  })
  const finished = evaluateMaestroGate(previous, {
    round: 2,
    phase: "review",
    checkpoint: "Independent review found no material gap.",
    unresolved: [],
    nextActions: [],
    evidence: ["review verified every requirement"],
    finalAnswer: "Reviewed final answer",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: ["Every requirement checked against the immutable success criterion"],
    completionVerified: true,
  }, "internal-task-token")
  assert.equal(finished.action, "finish")
  assert.equal(finished.phase, "done")
  assert.equal(finished.finalAnswer, "Reviewed final answer")
  assert.equal(finished.completionVerified, true)
  assert.ok(finished.reviewEvidence.length > 0)
  assert.equal(finished.nextPrompt, "")
})

test("internal task token is signed and bound to one task", () => {
  const token = issueMaestroTaskToken({ userId: "user-a", jobId: "job-a" })
  const verified = verifyMaestroTaskToken(token)
  assert.equal(verified?.userId, "user-a")
  assert.equal(verified?.jobId, "job-a")
  assert.equal(verifyMaestroTaskToken(`${token}x`), null)
})
