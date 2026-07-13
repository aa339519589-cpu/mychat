import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  commitWorkspaceChanges,
  getWorkspaceGitStatus,
  pushAgentBranch,
} from "../lib/agent/git-publish/git-operations"
import { createWorkspacePullRequest } from "../lib/agent/git-publish/pull-request"
import { publishWorkspaceToPullRequest } from "../lib/agent/git-publish/publish"
import { workspaceRoot } from "../lib/agent/workspace"

const now = "2026-07-13T00:00:00.000Z"
const userId = "git-publish-user"

type Result = { data: unknown; error: null | { message: string } }
type Operation = "select" | "insert" | "update"

function dataClient(taskId: string, options: {
  branch?: string
  agentBranch?: string | null
  status?: string
  repo?: string | null
  artifacts?: unknown[]
} = {}) {
  const writes: Array<{ table: string; operation: Operation; payload: unknown }> = []
  const task = {
    id: taskId,
    user_id: userId,
    goal: "Ship backend hardening",
    mode: "auto",
    repo: options.repo === undefined ? "owner/repo" : options.repo,
    branch: options.branch ?? "main",
    status: options.status ?? "running",
    error: null,
    meta: null,
    created_at: now,
    updated_at: now,
    agent_branch: options.agentBranch ?? null,
    commit_sha: null,
  }

  class Query {
    private operation: Operation = "select"
    private payload: unknown = null

    constructor(private readonly table: string) {}
    select() { return this }
    insert(payload: unknown) { this.operation = "insert"; this.payload = payload; return this }
    update(payload: unknown) { this.operation = "update"; this.payload = payload; return this }
    eq() { return this }
    neq() { return this }
    order() { return this }
    limit() { return this }

    private resolve(many: boolean): Result {
      if (this.operation !== "select") writes.push({ table: this.table, operation: this.operation, payload: this.payload })
      if (this.table === "agent_tasks") {
        return { data: many ? [task] : { ...task, ...(this.payload as object) }, error: null }
      }
      if (this.table === "agent_workspaces") {
        const workspace = {
          id: "workspace",
          task_id: taskId,
          user_id: userId,
          repo: task.repo,
          branch: task.branch,
          commit_sha: null,
          path: workspaceRoot(taskId, userId),
          status: "dirty",
          created_at: now,
          updated_at: now,
        }
        return { data: many ? [workspace] : workspace, error: null }
      }
      if (this.table === "agent_task_steps") {
        const step = {
          id: crypto.randomUUID(), task_id: taskId, user_id: userId, kind: "info",
          label: null, detail: null, seq: 1, created_at: now, ...(this.payload as object),
        }
        return { data: many ? [step] : step, error: null }
      }
      if (this.table === "agent_tool_calls") return { data: many ? [] : null, error: null }
      const artifact = {
        id: crypto.randomUUID(), task_id: taskId, user_id: userId, kind: "log",
        title: null, content: null, url: null, meta: null, created_at: now,
        ...(this.payload as object),
      }
      return {
        data: many ? (options.artifacts ?? []) : artifact,
        error: null,
      }
    }

    single() { return Promise.resolve(this.resolve(false)) }
    maybeSingle() { return Promise.resolve(this.resolve(false)) }
    then<TResult1 = Result, TResult2 = never>(
      onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(this.resolve(true)).then(onfulfilled, onrejected)
    }
  }

  return {
    client: { from: (table: string) => new Query(table) } as unknown as SupabaseClient,
    writes,
  }
}

function initializeRepository(taskId: string, branch = "agent/backend-hardening") {
  const root = workspaceRoot(taskId, userId)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: root })
  execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  writeFileSync(`${root}/README.md`, "baseline\n")
  execFileSync("git", ["add", "README.md"], { cwd: root })
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root })
  return root
}

function interceptGitPush(t: test.TestContext, shouldFail = false) {
  const bin = `/tmp/mychat-git-wrapper-${crypto.randomUUID()}`
  const originalPath = process.env.PATH ?? ""
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim()
  mkdirSync(bin, { recursive: true })
  writeFileSync(`${bin}/git`, [
    "#!/bin/sh",
    `if [ "$1" = "push" ]; then ${shouldFail ? "echo push-token-leak >&2; exit 1" : "exit 0"}; fi`,
    `exec ${JSON.stringify(realGit)} "$@"`,
  ].join("\n"))
  chmodSync(`${bin}/git`, 0o755)
  process.env.PATH = `${bin}:${originalPath}`
  t.after(() => {
    process.env.PATH = originalPath
    rmSync(bin, { recursive: true, force: true })
  })
}

test("git status distinguishes missing, clean, tracked, and untracked workspaces", t => {
  const taskId = `status-${crypto.randomUUID()}`
  const root = workspaceRoot(taskId, userId)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(getWorkspaceGitStatus(taskId, userId), { ok: false, error: "Workspace 不存在" })

  initializeRepository(taskId)
  const clean = getWorkspaceGitStatus(taskId, userId)
  assert.equal(clean.ok, true)
  assert.equal(clean.currentBranch, "agent/backend-hardening")
  assert.equal(clean.hasChanges, false)
  assert.match(clean.commitSha ?? "", /^[a-f0-9]{40}$/)

  writeFileSync(`${root}/README.md`, "changed\n")
  writeFileSync(`${root}/new.txt`, "new\n")
  const dirty = getWorkspaceGitStatus(taskId, userId)
  assert.equal(dirty.hasChanges, true)
  assert.match(dirty.diffPreview ?? "", /README\.md/)
})

test("workspace commit blocks protected branches and sensitive files", async t => {
  const mainTask = `main-${crypto.randomUUID()}`
  const mainRoot = initializeRepository(mainTask, "main")
  t.after(() => rmSync(mainRoot, { recursive: true, force: true }))
  writeFileSync(`${mainRoot}/README.md`, "changed\n")
  const main = await commitWorkspaceChanges(mainTask, userId, "unsafe", dataClient(mainTask).client)
  assert.match(main.error ?? "", /禁止在 main/)

  const secretTask = `secret-${crypto.randomUUID()}`
  const secretRoot = initializeRepository(secretTask)
  t.after(() => rmSync(secretRoot, { recursive: true, force: true }))
  writeFileSync(`${secretRoot}/.env.production`, "SECRET=value\n")
  const secret = await commitWorkspaceChanges(secretTask, userId, "unsafe", dataClient(secretTask).client)
  assert.match(secret.error ?? "", /禁止提交高危文件/)
})

test("workspace commit records the real SHA and persistence receipts", async t => {
  const taskId = `commit-${crypto.randomUUID()}`
  const root = initializeRepository(taskId)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(`${root}/README.md`, "hardened\n")
  writeFileSync(`${root}/safe.txt`, "safe\n")
  const database = dataClient(taskId)
  const result = await commitWorkspaceChanges(taskId, userId, "Backend hardening", database.client)
  assert.equal(result.ok, true)
  assert.match(result.commitSha ?? "", /^[a-f0-9]{40}$/)
  assert.deepEqual(new Set(result.changedFiles), new Set(["README.md", "safe.txt"]))
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "")
  assert.ok(database.writes.some(write => write.table === "agent_task_steps"))
  assert.ok(database.writes.some(write => write.table === "agent_artifacts"))
  assert.ok(database.writes.some(write => write.table === "agent_tasks"))
})

test("pull request creation sends the exact safe head and records the URL", { concurrency: false }, async t => {
  const taskId = `pr-${crypto.randomUUID()}`
  const root = initializeRepository(taskId, "main")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync("git", ["checkout", "-qb", "agent/backend-hardening"], { cwd: root })
  writeFileSync(`${root}/README.md`, "ready\n")
  execFileSync("git", ["add", "README.md"], { cwd: root })
  execFileSync("git", ["commit", "-qm", "ready"], { cwd: root })

  let requestBody: Record<string, unknown> = {}
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ html_url: "https://github.com/owner/repo/pull/7", number: 7 })
  })
  const database = dataClient(taskId, { agentBranch: "agent/backend-hardening" })
  const result = await createWorkspacePullRequest(taskId, userId, "secret-token", database.client)
  assert.equal(result.ok, true)
  assert.equal(result.pullRequestNumber, 7)
  assert.equal(requestBody.head, "agent/backend-hardening")
  assert.equal(requestBody.base, "main")
  assert.match(String(requestBody.body), /README\.md/)
  assert.equal(String(requestBody.body).includes("secret-token"), false)
})

test("pull request creation reuses an existing 422 response", { concurrency: false }, async t => {
  const taskId = `existing-pr-${crypto.randomUUID()}`
  const root = initializeRepository(taskId, "main")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync("git", ["checkout", "-qb", "agent/existing"], { cwd: root })
  writeFileSync(`${root}/README.md`, "existing\n")
  execFileSync("git", ["commit", "-qam", "existing"], { cwd: root })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    return calls === 1
      ? Response.json({ message: "already exists" }, { status: 422 })
      : Response.json([{ html_url: "https://github.com/owner/repo/pull/9", number: 9 }])
  })
  const result = await createWorkspacePullRequest(
    taskId,
    userId,
    "token",
    dataClient(taskId, { agentBranch: "agent/existing" }).client,
  )
  assert.equal(result.ok, true)
  assert.equal(result.pullRequestNumber, 9)
  assert.equal(calls, 2)
})

test("pull request creation fails safely for invalid task state and upstream shapes", { concurrency: false }, async t => {
  const noRepo = await createWorkspacePullRequest(
    `no-repo-${crypto.randomUUID()}`,
    userId,
    "token",
    dataClient(`no-repo-${crypto.randomUUID()}`, { repo: null }).client,
  )
  assert.match(noRepo.error ?? "", /未关联仓库/)

  const protectedHead = await createWorkspacePullRequest(
    `protected-${crypto.randomUUID()}`,
    userId,
    "token",
    dataClient(`protected-${crypto.randomUUID()}`, { agentBranch: "main" }).client,
  )
  assert.match(protectedHead.error ?? "", /禁止从 main/)

  const taskId = `bad-pr-${crypto.randomUUID()}`
  const root = initializeRepository(taskId, "main")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync("git", ["checkout", "-qb", "agent/bad-pr"], { cwd: root })
  writeFileSync(`${root}/README.md`, "bad\n")
  execFileSync("git", ["commit", "-qam", "bad"], { cwd: root })
  const database = dataClient(taskId, { agentBranch: "agent/bad-pr" }).client

  const deniedFetch = t.mock.method(globalThis, "fetch", async () => Response.json({ message: "denied" }, { status: 403 }))
  assert.match((await createWorkspacePullRequest(taskId, userId, "token", database)).error ?? "", /denied/)
  deniedFetch.mock.restore()

  const incompleteFetch = t.mock.method(globalThis, "fetch", async () => Response.json({ number: 3 }))
  assert.match((await createWorkspacePullRequest(taskId, userId, "token", database)).error ?? "", /未获取到 URL/)
  incompleteFetch.mock.restore()

  t.mock.method(globalThis, "fetch", async () => { throw new Error("network offline") })
  assert.match((await createWorkspacePullRequest(taskId, userId, "token", database)).error ?? "", /network offline/)
})

test("full workspace publish commits, intercepts push, and creates the PR", { concurrency: false }, async t => {
  const taskId = `publish-${crypto.randomUUID()}`
  const root = initializeRepository(taskId, "main")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync("git", ["checkout", "-qb", "agent/backend-hardening"], { cwd: root })
  writeFileSync(`${root}/README.md`, "published\n")
  interceptGitPush(t)
  t.mock.method(globalThis, "fetch", async () => Response.json({
    html_url: "https://github.com/owner/repo/pull/11",
    number: 11,
  }))
  const database = dataClient(taskId, { agentBranch: "agent/backend-hardening" })
  const result = await publishWorkspaceToPullRequest(taskId, userId, "token", database.client)
  assert.equal(result.ok, true)
  assert.equal(result.commit?.ok, true)
  assert.equal(result.push?.ok, true)
  assert.equal(result.pr?.pullRequestNumber, 11)
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "")
})

test("publish reports a redacted push failure and releases to failed state", { concurrency: false }, async t => {
  const taskId = `push-fail-${crypto.randomUUID()}`
  const root = initializeRepository(taskId)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(`${root}/README.md`, "push failure\n")
  interceptGitPush(t, true)
  const database = dataClient(taskId, { agentBranch: "agent/backend-hardening" })
  const result = await publishWorkspaceToPullRequest(taskId, userId, "push-token-leak", database.client)
  assert.equal(result.stage, "push")
  assert.equal(result.error?.includes("push-token-leak"), false)
  assert.ok(database.writes.some(write => (
    write.table === "agent_tasks"
    && JSON.stringify(write.payload).includes("failed")
  )))
})

test("publishing and pushing fail before external mutation when workspace state is unsafe", async t => {
  const missingTask = `missing-${crypto.randomUUID()}`
  const published = await publishWorkspaceToPullRequest(
    missingTask, userId, "token", dataClient(missingTask).client,
  )
  assert.equal(published.stage, "status")

  const protectedTask = `push-${crypto.randomUUID()}`
  const root = initializeRepository(protectedTask, "main")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pushed = await pushAgentBranch(protectedTask, userId, "token", dataClient(protectedTask).client)
  assert.match(pushed.error ?? "", /禁止推送 main/)
})
