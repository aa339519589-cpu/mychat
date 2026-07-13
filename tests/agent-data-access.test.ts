import assert from "node:assert/strict"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"

import {
  addArtifact,
  addStep,
  addToolCall,
  addWorkspace,
  cancelTask,
  completeToolCall,
  createTask,
  getTaskDetail,
  listTasks,
  resumeTask,
  updateTaskStatus,
  updateWorkspaceStatus,
} from "../lib/agent/data"

const now = "2026-07-13T00:00:00.000Z"
const taskId = "10000000-0000-4000-8000-000000000001"
const userId = "20000000-0000-4000-8000-000000000001"

type MockResult = { data: unknown; error: null | { message: string } }
type Operation = "select" | "insert" | "update" | "upsert"

function taskRow(status = "queued") {
  return {
    id: taskId,
    user_id: userId,
    goal: "Improve backend",
    mode: "auto",
    repo: "owner/repo",
    branch: "main",
    status,
    error: null,
    meta: null,
    created_at: now,
    updated_at: now,
  }
}

function createDataClient() {
  let selectedStatus = "running"
  const writes: Array<{ table: string; operation: Operation; payload: unknown }> = []

  function resolve(table: string, operation: Operation, payload: unknown, terminal: "single" | "maybe" | "many"): MockResult {
    if (operation !== "select") writes.push({ table, operation, payload })
    if (table === "agent_tasks") {
      if (operation === "insert") return { data: { ...taskRow(), ...(payload as object) }, error: null }
      if (operation === "update") return { data: { ...taskRow(), ...(payload as object) }, error: null }
      if (terminal === "many") return { data: [taskRow(selectedStatus)], error: null }
      return { data: terminal === "maybe" ? { status: selectedStatus } : taskRow(selectedStatus), error: null }
    }
    if (table === "agent_task_steps") {
      const row = { id: "step", task_id: taskId, user_id: userId, kind: "info", label: null, detail: null, seq: 1, created_at: now, ...(payload as object) }
      return { data: terminal === "many" ? [row] : row, error: null }
    }
    if (table === "agent_tool_calls") {
      if (operation === "select" && terminal === "single") return { data: { started_at: now }, error: null }
      const row = {
        id: "call", task_id: taskId, user_id: userId, step_id: null, tool_name: "read_file",
        input: null, output: null, error: null, status: "pending", started_at: now,
        finished_at: null, duration_ms: null, seq: 1, created_at: now, ...(payload as object),
      }
      return { data: terminal === "many" ? [row] : row, error: null }
    }
    if (table === "agent_workspaces") {
      const row = {
        id: "workspace", task_id: taskId, user_id: userId, repo: "owner/repo", branch: "main",
        commit_sha: null, path: null, status: "created", created_at: now, updated_at: now, ...(payload as object),
      }
      return { data: terminal === "many" ? [row] : row, error: null }
    }
    const row = {
      id: "artifact", task_id: taskId, user_id: userId, kind: "log", title: null,
      content: null, url: null, meta: null, created_at: now, ...(payload as object),
    }
    return { data: terminal === "many" ? [row] : row, error: null }
  }

  class Query {
    private operation: Operation = "select"
    private payload: unknown = null

    constructor(private readonly table: string) {}
    select() { return this }
    insert(payload: unknown) { this.operation = "insert"; this.payload = payload; return this }
    update(payload: unknown) { this.operation = "update"; this.payload = payload; return this }
    upsert(payload: unknown) { this.operation = "upsert"; this.payload = payload; return this }
    eq() { return this }
    order() { return this }
    limit() { return this }
    single() { return Promise.resolve(resolve(this.table, this.operation, this.payload, "single")) }
    maybeSingle() { return Promise.resolve(resolve(this.table, this.operation, this.payload, "maybe")) }
    then<TResult1 = MockResult, TResult2 = never>(
      onfulfilled?: ((value: MockResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(resolve(this.table, this.operation, this.payload, "many")).then(onfulfilled, onrejected)
    }
  }

  return {
    client: { from: (table: string) => new Query(table) } as unknown as SupabaseClient,
    writes,
    setStatus(status: string) { selectedStatus = status },
  }
}

test("agent data access maps every persisted entity and status transition", async () => {
  const mock = createDataClient()
  const created = await createTask(mock.client, userId, { goal: "Improve backend", repo: "owner/repo" })
  assert.ok("id" in created)
  if (!("id" in created)) return
  assert.match(created.id, /^[0-9a-f-]{36}$/)

  assert.equal((await listTasks(mock.client, userId, { status: "running", repo: "owner/repo", limit: 5 })).length, 1)
  const detail = await getTaskDetail(mock.client, userId, taskId)
  assert.ok("id" in detail)
  if (!("id" in detail)) return
  assert.equal(detail.steps.length, 1)
  assert.equal(detail.toolCalls.length, 1)
  assert.equal(detail.workspace?.id, "workspace")
  assert.equal(detail.artifacts.length, 1)

  const updated = await updateTaskStatus(mock.client, userId, taskId, "completed", {
    error: null,
    startedAt: now,
    finishedAt: now,
    agentBranch: "agent/task",
    pullRequestUrl: "https://github.com/owner/repo/pull/1",
    pullRequestNumber: 1,
    commitSha: "commit",
  })
  assert.ok("id" in updated)
  if (!("id" in updated)) return
  assert.equal(updated.status, "completed")

  const step = await addStep(mock.client, userId, taskId, { kind: "info", label: "Started", detail: "detail" })
  assert.ok("id" in step)
  const call = await addToolCall(mock.client, userId, {
    taskId,
    stepId: "step",
    toolName: "read_file",
    input: { path: "README.md" },
    status: "running",
  })
  assert.ok("id" in call)
  const completedCall = await completeToolCall(mock.client, userId, "call", {
    status: "success",
    output: { content: "ok" },
  })
  assert.ok("id" in completedCall)
  if ("id" in completedCall) assert.equal(completedCall.status, "success")

  const workspace = await addWorkspace(mock.client, userId, {
    taskId, repo: "owner/repo", branch: "dev", commitSha: "base", path: "/tmp/workspace",
  })
  assert.ok("id" in workspace)
  const dirty = await updateWorkspaceStatus(mock.client, userId, taskId, "dirty", { path: "/tmp/workspace", commitSha: "next" })
  assert.ok("id" in dirty)
  const artifact = await addArtifact(mock.client, userId, {
    taskId, kind: "log", title: "Build", content: "passed", url: "https://example.com", meta: { ok: true },
  })
  assert.ok("id" in artifact)
  assert.ok(mock.writes.length >= 9)
})

test("agent cancellation and resume enforce terminal state rules", async () => {
  const mock = createDataClient()
  mock.setStatus("completed")
  assert.deepEqual(await cancelTask(mock.client, userId, taskId), { error: "当前状态 completed 不可取消" })
  assert.deepEqual(await resumeTask(mock.client, userId, taskId), { error: "当前状态 completed 不可恢复" })

  mock.setStatus("running")
  const cancelled = await cancelTask(mock.client, userId, taskId)
  assert.ok("id" in cancelled)
  if ("id" in cancelled) assert.equal(cancelled.status, "cancelled")

  mock.setStatus("failed")
  const resumed = await resumeTask(mock.client, userId, taskId)
  assert.ok("id" in resumed)
  if ("id" in resumed) assert.equal(resumed.status, "queued")
})

test("agent data access returns stable errors when persistence is unavailable", async () => {
  const failed = { data: null, error: { message: "database unavailable" } }
  class FailedQuery {
    select() { return this }
    insert() { return this }
    update() { return this }
    upsert() { return this }
    eq() { return this }
    order() { return this }
    limit() { return this }
    single() { return Promise.resolve(failed) }
    maybeSingle() { return Promise.resolve(failed) }
    then<TResult1 = typeof failed, TResult2 = never>(
      onfulfilled?: ((value: typeof failed) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(failed).then(onfulfilled, onrejected)
    }
  }
  const client = { from: () => new FailedQuery() } as unknown as SupabaseClient

  assert.deepEqual(await createTask(client, userId, { goal: "fail" }), { error: "database unavailable" })
  assert.deepEqual(await listTasks(client, userId), [])
  assert.deepEqual(await getTaskDetail(client, userId, taskId), { error: "database unavailable" })
  assert.deepEqual(await updateTaskStatus(client, userId, taskId, "failed"), { error: "database unavailable" })
  assert.deepEqual(await cancelTask(client, userId, taskId), { error: "任务不存在" })
  assert.deepEqual(await resumeTask(client, userId, taskId), { error: "任务不存在" })
  assert.deepEqual(await addStep(client, userId, taskId, { kind: "error" }), { error: "database unavailable" })
  assert.deepEqual(await addToolCall(client, userId, { taskId, toolName: "read_file" }), { error: "database unavailable" })
  assert.deepEqual(await completeToolCall(client, userId, "call", { status: "error", error: "failed" }), { error: "database unavailable" })
  assert.deepEqual(await addWorkspace(client, userId, { taskId, repo: "owner/repo" }), { error: "database unavailable" })
  assert.deepEqual(await updateWorkspaceStatus(client, userId, taskId, "failed"), { error: "database unavailable" })
  assert.deepEqual(await addArtifact(client, userId, { taskId, kind: "log" }), { error: "database unavailable" })
})
