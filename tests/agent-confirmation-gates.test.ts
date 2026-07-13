import assert from "node:assert/strict"
import test from "node:test"

import {
  canonicalAgentOperationPlan,
  createAgentConfirmationToken,
  parseAgentConfirmationCredential,
  sha256,
  type AgentOperationPlan,
} from "../lib/agent/confirmation-plan"

const basePlan: AgentOperationPlan = {
  version: 1,
  userId: "00000000-0000-4000-8000-000000000001",
  taskId: "85000000-0000-4000-8000-000000000001",
  repo: "owner/repo",
  operation: "publish",
  files: [".github/workflows/deploy.yml"],
  baseBranch: "main",
  workspaceBranch: "agent/task",
  head: "a".repeat(40),
  workspaceStateSha256: "b".repeat(64),
  payload: { deployPages: true, titleSha256: "c".repeat(64) },
}

test("canonical confirmation plans are deterministic and bind every risky field", () => {
  const canonical = canonicalAgentOperationPlan(basePlan)
  const reordered: AgentOperationPlan = {
    payload: { titleSha256: "c".repeat(64), deployPages: true },
    workspaceStateSha256: "b".repeat(64),
    head: "a".repeat(40),
    workspaceBranch: "agent/task",
    baseBranch: "main",
    files: [".github/workflows/deploy.yml"],
    operation: "publish",
    repo: "owner/repo",
    taskId: "85000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000001",
    version: 1,
  }
  assert.equal(canonicalAgentOperationPlan(reordered), canonical)

  for (const changed of [
    { ...basePlan, userId: "00000000-0000-4000-8000-000000000002" },
    { ...basePlan, repo: "owner/other" },
    { ...basePlan, files: ["supabase/migrations/new.sql"] },
    { ...basePlan, head: "d".repeat(40) },
    { ...basePlan, workspaceStateSha256: "e".repeat(64) },
    { ...basePlan, payload: { ...basePlan.payload, deployPages: false } },
  ]) {
    assert.notEqual(sha256(canonicalAgentOperationPlan(changed)), sha256(canonical))
  }
})

test("confirmation bearer tokens contain 256 random bits and persist by digest", () => {
  const first = createAgentConfirmationToken()
  const second = createAgentConfirmationToken()
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/)
  assert.match(first.tokenSha256, /^[0-9a-f]{64}$/)
  assert.equal(first.tokenSha256, sha256(first.token))
  assert.notEqual(first.token, second.token)
  assert.notEqual(first.tokenSha256, second.tokenSha256)
  assert.equal(first.tokenSha256.includes(first.token), false)
})

test("confirmation credentials are all-or-nothing and strictly formatted", () => {
  const credential = {
    confirmationId: "85000000-0000-4000-8000-000000000001",
    confirmationToken: "A".repeat(43),
  }
  assert.deepEqual(parseAgentConfirmationCredential(credential), credential)
  assert.equal(parseAgentConfirmationCredential({}), null)
  assert.throws(() => parseAgentConfirmationCredential({ confirmationId: credential.confirmationId }))
  assert.throws(() => parseAgentConfirmationCredential({ ...credential, confirmationToken: "short" }))
  assert.throws(() => parseAgentConfirmationCredential({ ...credential, confirmationId: "not-a-uuid" }))
})

test("migration exposes only fenced RPCs and uses row locks for approval and consumption", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile(
    new URL("../supabase/migrations/20260713120000_agent_confirmation_gates.sql", import.meta.url),
    "utf8",
  ))
  assert.match(source, /revoke all on table public\.agent_confirmation_gates[\s\S]*service_role/i)
  assert.match(source, /token_hash bytea[\s\S]*octet_length\(token_hash\) = 32/i)
  assert.match(source, /digest\(convert_to\(input_plan_canonical, 'UTF8'\), 'sha256'\)/i)
  assert.match(source, /from public\.agent_confirmation_gates[\s\S]*for update;/i)
  assert.match(source, /where id = v_gate\.id and status = 'approved'/i)
  assert.doesNotMatch(source, /confirmationToken/i)
})

test("HTTP workspace mutations are disabled and durable publish consumes the authoritative gate", async () => {
  const fs = await import("node:fs/promises")
  const disabledRoutes = await Promise.all([
    "../app/api/agent/tasks/[taskId]/workspace/file/route.ts",
    "../app/api/agent/tasks/[taskId]/workspace/patch/route.ts",
    "../app/api/agent/tasks/[taskId]/workspace/restore/route.ts",
    "../app/api/agent/tasks/[taskId]/workspace/verify/route.ts",
  ].map(path => fs.readFile(new URL(path, import.meta.url), "utf8")))
  for (const source of disabledRoutes) {
    assert.match(source, /legacyWorkspaceMutationDisabled/)
  }

  const [gitRoute, apply, enqueue, handler] = await Promise.all([
    "../app/api/agent/tasks/[taskId]/workspace/git/route.ts",
    "../lib/code-agent/apply.ts",
    "../lib/code-agent/operation-enqueue.ts",
    "../lib/jobs/handlers/agent-operation.ts",
  ].map(path => fs.readFile(new URL(path, import.meta.url), "utf8")))
  assert.match(gitRoute, /HTTP 直发已停用/)
  assert.match(apply, /prepareAgentOperation/)
  assert.match(enqueue, /enqueue_agent_operation/)
  assert.match(enqueue, /input_token_sha256: sha256/)
  assert.match(handler, /loadAgentOperation/)
  assert.match(handler, /executeFencedToolEffect/)
  assert.match(handler, /restoreWorkspaceSnapshot/)

  const confirmRoute = await fs.readFile(new URL(
    "../app/api/agent/tasks/[taskId]/confirm/route.ts", import.meta.url,
  ), "utf8")
  assert.match(confirmRoute, /body\.action !== "confirm" && body\.action !== "reject"/)
  assert.match(confirmRoute, /isAgentConfirmationOperation\(body\.operation\)/)
  assert.match(confirmRoute, /parseAgentConfirmationCredential\(body\)/)
  assert.doesNotMatch(confirmRoute, /body\.action === "reject" \? "reject" : "confirm"/)

  const workerTools = await fs.readFile(new URL("../lib/code-tools/index.ts", import.meta.url), "utf8")
  assert.match(workerTools, /classifyFileRisk\(paths\)/)
  assert.match(workerTools, /classifyFileRisk\(preview\.changedFiles\)/)
  assert.match(workerTools, /该操作只能由客户端通过数据库单次确认门提交/)
})
