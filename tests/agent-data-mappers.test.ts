import assert from "node:assert/strict"
import test from "node:test"

import { mapTask, mapWorkspace } from "../lib/agent/data-mappers"

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
