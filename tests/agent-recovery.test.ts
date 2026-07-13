import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { saveWorkspaceCheckpoint, restoreLatestWorkspaceCheckpoint } from "../lib/agent/checkpoint"
import { getChangedFiles, workspaceRoot } from "../lib/agent/workspace"
import { compactRunMessages } from "../lib/agent/run-state"
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "../lib/agent/snapshot"
import { detectProjectCommands } from "../lib/agent/project-detect"
import type { SupabaseClient } from "@supabase/supabase-js"

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
  const snapshotRoot = `/tmp/mychat-agent-snapshots/${userId}/${taskId}`
  let taskMeta: Record<string, unknown> = {}
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => rmSync(snapshotRoot, { recursive: true, force: true }))

  class Query {
    select() { return this }
    eq() { return this }
    single() { return Promise.resolve({ data: { meta: taskMeta }, error: null }) }
  }
  const supabase = {
    rpc(name: string, input: { patch?: Record<string, unknown> }) {
      assert.equal(name, "merge_agent_task_meta")
      taskMeta = { ...taskMeta, ...input.patch }
      return Promise.resolve({ data: taskMeta, error: null })
    },
    from() {
      return {
        select() { return new Query() },
      }
    },
  } as unknown as SupabaseClient

  mkdirSync(root, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.name", "test"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  writeFileSync(`${root}/README.md`, "base\n")
  execFileSync("git", ["add", "README.md"], { cwd: root })
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root })

  writeFileSync(`${root}/README.md`, "base\nchanged\n")
  writeFileSync(`${root}/new.txt`, "new file\n")
  const snapshot = await createWorkspaceSnapshot(taskId, userId, "test")
  assert.equal(snapshot.ok, true)
  assert.equal(existsSync(`${root}/.claude`), false)
  assert.equal(existsSync(snapshotRoot), true)
  assert.deepEqual(await saveWorkspaceCheckpoint(supabase, userId, taskId), { ok: true })

  execFileSync("git", ["reset", "--hard", "-q", "HEAD"], { cwd: root })
  unlinkSync(`${root}/new.txt`)
  assert.deepEqual(await restoreLatestWorkspaceCheckpoint(supabase, userId, taskId), { ok: true, restored: true })
  assert.equal(readFileSync(`${root}/README.md`, "utf8"), "base\nchanged\n")
  assert.equal(readFileSync(`${root}/new.txt`, "utf8"), "new file\n")
})

test("workspace status keeps the first filename intact and npm install does not create a lockfile", t => {
  const taskId = `status-${Date.now()}`
  const userId = "test-user"
  const root = workspaceRoot(taskId, userId)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(root, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.name", "test"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  writeFileSync(`${root}/README.md`, "base\n")
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { test: "echo ok" } }))
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root })
  writeFileSync(`${root}/README.md`, "changed\n")

  const changed = getChangedFiles(taskId, userId)
  assert.equal(changed.ok, true)
  if (changed.ok) assert.equal(changed.data.files[0]?.path, "README.md")
  assert.equal(detectProjectCommands(taskId, userId).installCommand, "npm install --no-package-lock")
})

test("a clean pre-change snapshot can undo the first workspace edit", async t => {
  const taskId = `clean-snapshot-${Date.now()}`
  const userId = "test-user"
  const root = workspaceRoot(taskId, userId)
  const snapshotRoot = `/tmp/mychat-agent-snapshots/${userId}/${taskId}`
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => rmSync(snapshotRoot, { recursive: true, force: true }))
  mkdirSync(root, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.name", "test"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  writeFileSync(`${root}/README.md`, "base\n")
  execFileSync("git", ["add", "README.md"], { cwd: root })
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root })

  const snapshot = await createWorkspaceSnapshot(taskId, userId, "before first edit")
  assert.equal(snapshot.ok, true)
  if (!snapshot.ok) return
  writeFileSync(`${root}/README.md`, "changed\n")
  writeFileSync(`${root}/new.txt`, "new\n")
  const restored = await restoreWorkspaceSnapshot(taskId, userId, snapshot.snapshot.snapshotId)
  assert.equal(restored.ok, true)
  assert.equal(readFileSync(`${root}/README.md`, "utf8"), "base\n")
  assert.equal(existsSync(`${root}/new.txt`), false)
})
