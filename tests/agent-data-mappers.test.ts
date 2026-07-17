import assert from "node:assert/strict"
import test from "node:test"

import {
  mapArtifact,
  mapStep,
  mapTask,
  mapToolCall,
  mapWorkspace,
} from "../lib/agent/data-mappers"

test("agent task rows map storage names and stable defaults into domain contracts", () => {
  const task = mapTask({
    id: "task",
    user_id: "user",
    goal: "ship it",
    mode: "auto",
    status: "queued",
    created_at: "created",
    updated_at: "updated",
  })

  assert.equal(task.userId, "user")
  assert.equal(task.branch, "main")
  assert.equal(task.repo, null)
  assert.equal(task.pullRequestUrl, null)
})

test("agent workspace rows keep explicit branches and normalize nullable fields", () => {
  const workspace = mapWorkspace({
    id: "workspace",
    task_id: "task",
    user_id: "user",
    repo: "owner/repo",
    branch: "codex/refactor",
    status: "ready",
    created_at: "created",
    updated_at: "updated",
  })

  assert.equal(workspace.taskId, "task")
  assert.equal(workspace.branch, "codex/refactor")
  assert.equal(workspace.commitSha, null)
})

test("agent row mappers reject unknown database enum values", () => {
  const common = { id: "id", user_id: "user", created_at: "created" }

  assert.throws(() => mapTask({
    ...common,
    goal: "goal",
    mode: "unsafe",
    status: "queued",
    updated_at: "updated",
  }), /Invalid agent task mode: unsafe/)
  assert.throws(() => mapTask({
    ...common,
    goal: "goal",
    mode: "auto",
    status: "unknown",
    updated_at: "updated",
  }), /Invalid agent task status: unknown/)
  assert.throws(() => mapStep({
    ...common,
    task_id: "task",
    kind: "unknown",
    seq: 1,
  }), /Invalid agent step kind: unknown/)
  assert.throws(() => mapToolCall({
    ...common,
    task_id: "task",
    tool_name: "test",
    status: "unknown",
    seq: 1,
  }), /Invalid agent tool status: unknown/)
  assert.throws(() => mapWorkspace({
    ...common,
    task_id: "task",
    repo: "owner/repo",
    status: "unknown",
    updated_at: "updated",
  }), /Invalid agent workspace status: unknown/)
  assert.throws(() => mapArtifact({
    ...common,
    task_id: "task",
    kind: "unknown",
  }), /Invalid agent artifact kind: unknown/)
})
