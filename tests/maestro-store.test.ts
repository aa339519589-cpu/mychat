import test from "node:test"
import assert from "node:assert/strict"
import { clientMaestroTask, MAESTRO_BRANCH, MAESTRO_BUILTIN_HARD_RULES, MAESTRO_META_KIND, type AgentTaskRow } from "../lib/maestro/store"
import { issueMaestroTaskToken, verifyMaestroTaskToken } from "../lib/maestro/tokens"

process.env.MAESTRO_RUNNER_KEY = "test-maestro-runner-key-0123456789-abcdefghijklmnopqrstuvwxyz"

test("public Maestro task projection exposes the fixed contract and omits internal capability tokens", () => {
  const now = "2026-08-24T00:00:00.000Z"
  const row: AgentTaskRow = {
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
      successCriterion: "Prove unconditionally that kappa > 0.75",
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
  }
  const projected = clientMaestroTask(row)
  assert.ok(projected)
  assert.equal(projected.successCriterion, "Prove unconditionally that kappa > 0.75")
  assert.ok(projected.hardRules.length >= MAESTRO_BUILTIN_HARD_RULES.length)
  assert.equal("taskToken" in projected, false)
  assert.equal("startCode" in projected, false)
})

test("internal Maestro task token is signed and bound to one user and task", () => {
  const token = issueMaestroTaskToken({ userId: "user-a", jobId: "job-a" })
  assert.equal(verifyMaestroTaskToken(token)?.userId, "user-a")
  assert.equal(verifyMaestroTaskToken(token)?.jobId, "job-a")
  assert.equal(verifyMaestroTaskToken(`${token}x`), null)
})
