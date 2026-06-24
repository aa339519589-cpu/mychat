import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { saveWorkspaceCheckpoint, restoreLatestWorkspaceCheckpoint } from "../lib/agent/checkpoint"
import { workspaceRoot } from "../lib/agent/workspace"
import { compactRunMessages } from "../lib/agent/run-state"
import { openRecoveryToken, sealRecoveryToken } from "../lib/agent/recovery-token"

test("recovery tokens are encrypted, authenticated, and expire", { concurrency: false }, t => {
  const previous = process.env.AGENT_CREDENTIAL_KEY
  process.env.AGENT_CREDENTIAL_KEY = "test-key-that-is-long-enough-for-agent-recovery"
  t.after(() => { process.env.AGENT_CREDENTIAL_KEY = previous })

  const token = sealRecoveryToken({ taskId: "task-1", cookie: "secret-cookie", expiresAt: Date.now() + 60_000 })
  assert.ok(token)
  assert.doesNotMatch(token, /secret-cookie/)
  assert.deepEqual(openRecoveryToken(token!), {
    taskId: "task-1",
    cookie: "secret-cookie",
    expiresAt: openRecoveryToken(token!)?.expiresAt,
  })
  assert.equal(openRecoveryToken(`${token!.slice(0, -1)}x`), null)

  const expired = sealRecoveryToken({ taskId: "task-1", cookie: "secret-cookie", expiresAt: Date.now() - 1 })
  assert.equal(openRecoveryToken(expired!), null)
})

test("run checkpoints keep recent context and redact secrets", () => {
  const messages = Array.from({ length: 60 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: index === 59 ? "token sk-abcdefghijklmnopqrstuvwxyz123456" : `message-${index}`,
  }))
  const compacted = compactRunMessages(messages)
  assert.ok(compacted.length <= 49)
  assert.match(String(compacted.at(-1)?.content), /…/)
  assert.doesNotMatch(JSON.stringify(compacted), /sk-abcdefghijklmnopqrstuvwxyz123456/)
})

test("workspace checkpoint restores tracked and new files after local loss", async t => {
  const taskId = `checkpoint-${Date.now()}`
  const userId = "test-user"
  const root = workspaceRoot(taskId, userId)
  const artifacts: any[] = []
  t.after(() => rmSync(root, { recursive: true, force: true }))

  class Query {
    constructor(private operation: "select" | "delete") {}
    select() { return this }
    eq() { return this }
    neq() { return this }
    order() { return this }
    limit() { return this }
    then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
      const value = this.operation === "select" ? { data: artifacts, error: null } : { data: null, error: null }
      return Promise.resolve(value).then(resolve, reject)
    }
  }
  const supabase = {
    from() {
      return {
        insert(row: any) { artifacts.unshift({ ...row, created_at: new Date().toISOString() }); return Promise.resolve({ error: null }) },
        select() { return new Query("select") },
        delete() { return new Query("delete") },
      }
    },
  } as any

  mkdirSync(root, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.name", "test"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  writeFileSync(`${root}/README.md`, "base\n")
  execFileSync("git", ["add", "README.md"], { cwd: root })
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root })

  writeFileSync(`${root}/README.md`, "base\nchanged\n")
  writeFileSync(`${root}/new.txt`, "new file\n")
  assert.deepEqual(await saveWorkspaceCheckpoint(supabase, userId, taskId), { ok: true })

  execFileSync("git", ["reset", "--hard", "-q", "HEAD"], { cwd: root })
  unlinkSync(`${root}/new.txt`)
  assert.deepEqual(await restoreLatestWorkspaceCheckpoint(supabase, userId, taskId), { ok: true, restored: true })
  assert.equal(readFileSync(`${root}/README.md`, "utf8"), "base\nchanged\n")
  assert.equal(readFileSync(`${root}/new.txt`, "utf8"), "new file\n")
})
