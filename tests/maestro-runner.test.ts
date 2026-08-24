import test from "node:test"
import assert from "node:assert/strict"
import { MAESTRO_TOOLS, evaluateMaestroGate, handleMaestroRpc } from "../lib/maestro/mcp"
import { MAESTRO_WIDGET_HTML, MAESTRO_WIDGET_URI } from "../lib/maestro/widget"
import { issueMaestroTaskToken, verifyMaestroTaskToken } from "../lib/maestro/tokens"
import { clientMaestroTask, MAESTRO_BRANCH, MAESTRO_BUILTIN_HARD_RULES, MAESTRO_META_KIND, type AgentTaskRow } from "../lib/maestro/store"

process.env.MAESTRO_RUNNER_KEY = "test-maestro-runner-key-0123456789-abcdefghijklmnopqrstuvwxyz"

const SUCCESS_CRITERION = "Prove unconditionally that kappa > 0.75"

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
      successCriterion: SUCCESS_CRITERION,
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

test("Maestro exposes automatic creation without user relay codes", async () => {
  assert.deepEqual(MAESTRO_TOOLS.map(tool => tool.name), ["maestro_create_task", "maestro_start", "maestro_round_gate"])
  const serialized = JSON.stringify(MAESTRO_TOOLS)
  assert.doesNotMatch(serialized, /startCode/)
  assert.match(serialized, /taskToken/)
  assert.match(serialized, /criterionSatisfied/)
  assert.match(serialized, /reviewEvidence/)
  assert.equal("required" in MAESTRO_TOOLS[1].inputSchema, false)
  assert.equal(MAESTRO_TOOLS[1]._meta["openai/widgetAccessible"], true)

  const initialized = await handleMaestroRpc(
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { origin: "https://example.com", userId: null },
  )
  const result = initialized?.result as { capabilities: unknown; instructions: string }
  assert.deepEqual(result.capabilities, { tools: { listChanged: true }, resources: { listChanged: true } })
  assert.match(result.instructions, /authenticated My Chat user/)
  assert.match(result.instructions, /Only a separate review may finish/)
  assert.match(result.instructions, /never count as completion/)
  assert.doesNotMatch(result.instructions, /MAESTRO_OWNER_USER_ID/)
})

test("unauthenticated callers may scan tools but cannot execute Maestro actions", async () => {
  const listed = await handleMaestroRpc(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { origin: "https://example.com", userId: null },
  )
  assert.equal(Array.isArray((listed?.result as { tools?: unknown[] })?.tools), true)

  const called = await handleMaestroRpc(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "maestro_start", arguments: {} } },
    { origin: "https://example.com", userId: null },
  )
  const callResult = called?.result as { isError?: boolean; content?: Array<{ text?: string }> }
  assert.equal(callResult.isError, true)
  assert.match(callResult.content?.[0]?.text ?? "", /authenticated My Chat user/)
})

test("widget syncs through maestro_start and never scrapes or fetches ChatGPT", async () => {
  assert.match(MAESTRO_WIDGET_HTML, /sendFollowUpMessage/)
  assert.match(MAESTRO_WIDGET_HTML, /callTool\("maestro_start"/)
  assert.match(MAESTRO_WIDGET_HTML, /taskToken/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /startCode/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /fetch\s*\(/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /document\.querySelector/)
  assert.doesNotMatch(MAESTRO_WIDGET_HTML, /backend-api/)
  assert.match(MAESTRO_WIDGET_HTML, /累计推理墙钟/)

  const response = await handleMaestroRpc(
    { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: MAESTRO_WIDGET_URI } },
    { origin: "https://example.com", userId: null },
  )
  const contents = (response?.result as { contents: Array<{ uri: string; text: string }> }).contents
  assert.equal(contents[0].uri, MAESTRO_WIDGET_URI)
})

test("public task projection exposes immutable contract but hides internal capability", () => {
  const projected = clientMaestroTask(row())
  assert.ok(projected)
  assert.equal(projected?.successCriterion, SUCCESS_CRITERION)
  assert.ok((projected?.hardRules.length ?? 0) >= MAESTRO_BUILTIN_HARD_RULES.length)
  assert.equal("taskToken" in (projected ?? {}), false)
  assert.equal("startCode" in (projected ?? {}), false)
})

test("unfinished work always continues", () => {
  const continued = evaluateMaestroGate(row(), {
    ...gateBase(),
    round: 1,
    phase: "work",
    checkpoint: "One lemma remains.",
    unresolved: ["Lemma B"],
    nextActions: ["Prove Lemma B"],
  }, "internal-task-token")
  assert.equal(continued.action, "continue")
  assert.equal(continued.phase, "work")
  assert.equal(continued.completionVerified, false)
  assert.equal(continued.criterionSatisfied, false)
  assert.match(continued.nextPrompt, /第 2 轮/)
  assert.match(continued.nextPrompt, /不可变成功条件/)
  assert.match(continued.nextPrompt, /绝对不能作为 done=true/)
})

test("work done=true can only produce a review candidate, never finish", () => {
  const review = evaluateMaestroGate(row(), {
    ...gateBase(),
    round: 1,
    phase: "work",
    checkpoint: "Candidate claims closure.",
    finalAnswer: "Candidate answer",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: ["worker says it is true"],
  }, "internal-task-token")
  assert.equal(review.action, "review")
  assert.equal(review.phase, "review")
  assert.equal(review.finalAnswer, "")
  assert.equal(review.candidateAnswer, "Candidate answer")
  assert.equal(review.criterionSatisfied, false)
  assert.equal(review.completionVerified, false)
})

test("review cannot finish merely because work is impossible or tools are limited", () => {
  const previous = row({
    meta: {
      ...(row().meta as NonNullable<AgentTaskRow["meta"]> as never),
    } as AgentTaskRow["meta"],
  })
  const base = row()
  const meta = base.meta as Record<string, unknown>
  const reviewRow = row({
    meta: {
      ...meta,
      round: 1,
      phase: "review",
      candidateAnswer: "I cannot prove the target with current tools.",
      checkpoint: "No known route closes the gap.",
      lastAction: "review",
      currentInput: "independent review",
    } as AgentTaskRow["meta"],
  })

  const rejected = evaluateMaestroGate(reviewRow, {
    ...gateBase(),
    round: 2,
    phase: "review",
    checkpoint: "Unable to solve; tool limit reached.",
    finalAnswer: "Unable to prove the target.",
    done: true,
    criterionSatisfied: false,
    reviewEvidence: ["No proof exists in the supplied work"],
  }, "internal-task-token")

  assert.equal(rejected.action, "continue")
  assert.equal(rejected.phase, "work")
  assert.equal(rejected.status, "running")
  assert.equal(rejected.completionVerified, false)
  assert.equal(rejected.criterionSatisfied, false)
  assert.ok(rejected.unresolved.length > 0)
  assert.ok(rejected.nextActions.length > 0)
})

test("review with criterionSatisfied=true still cannot finish without independent review evidence", () => {
  const base = row()
  const meta = base.meta as Record<string, unknown>
  const reviewRow = row({
    meta: {
      ...meta,
      round: 1,
      phase: "review",
      candidateAnswer: "Candidate answer",
      lastAction: "review",
    } as AgentTaskRow["meta"],
  })

  const rejected = evaluateMaestroGate(reviewRow, {
    ...gateBase(),
    round: 2,
    phase: "review",
    finalAnswer: "Reviewed final answer",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: [],
  }, "internal-task-token")

  assert.equal(rejected.action, "continue")
  assert.equal(rejected.phase, "work")
  assert.equal(rejected.completionVerified, false)
})

test("only independent review that verifies the exact criterion may finish", () => {
  const base = row()
  const meta = base.meta as Record<string, unknown>
  const reviewRow = row({
    meta: {
      ...meta,
      round: 1,
      phase: "review",
      candidateAnswer: "Candidate proof",
      checkpoint: "Candidate produced",
      lastAction: "review",
      currentInput: "review candidate",
      currentRoundStartedAt: "2026-08-24T00:01:10.000Z",
      totalElapsedMs: 10000,
      lastOutput: "Candidate proof",
    } as AgentTaskRow["meta"],
  })

  const finished = evaluateMaestroGate(reviewRow, {
    ...gateBase(),
    round: 2,
    phase: "review",
    checkpoint: "Independent review verified the exact target.",
    evidence: ["proof steps independently checked"],
    finalAnswer: "Reviewed final answer",
    done: true,
    criterionSatisfied: true,
    reviewEvidence: ["Verified every essential inequality", "Verified the conclusion is exactly kappa > 0.75"],
  }, "internal-task-token")

  assert.equal(finished.action, "finish")
  assert.equal(finished.phase, "done")
  assert.equal(finished.finalAnswer, "Reviewed final answer")
  assert.equal(finished.criterionSatisfied, true)
  assert.equal(finished.completionVerified, true)
  assert.equal(finished.nextPrompt, "")
})

test("initial round horizon is not a completion barrier", () => {
  const base = row()
  const meta = base.meta as Record<string, unknown>
  const beyondBudget = row({
    meta: {
      ...meta,
      maxRounds: 1,
      round: 1,
      phase: "work",
      checkpoint: "Still unfinished",
    } as AgentTaskRow["meta"],
  })
  const continued = evaluateMaestroGate(beyondBudget, {
    ...gateBase(),
    round: 2,
    phase: "work",
    unresolved: ["Target not reached"],
    nextActions: ["Continue"],
  }, "internal-task-token")
  assert.equal(continued.action, "continue")
  assert.equal(continued.phase, "work")
  assert.equal(continued.completionVerified, false)
})

test("internal task token is signed and bound to one task", () => {
  const token = issueMaestroTaskToken({ userId: "user-a", jobId: "job-a" })
  const verified = verifyMaestroTaskToken(token)
  assert.equal(verified?.userId, "user-a")
  assert.equal(verified?.jobId, "job-a")
  assert.equal(verifyMaestroTaskToken(`${token}x`), null)
})
