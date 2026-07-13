import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createWorkspaceSnapshot, listWorkspaceSnapshots, restoreWorkspaceSnapshot } from "../lib/agent/snapshot"
import { workspaceRoot } from "../lib/agent/workspace"

function initWorkspace(taskId: string, userId: string): { root: string; snapshotRoot: string } {
  const root = workspaceRoot(taskId, userId)
  const snapshotRoot = `/tmp/mychat-agent-snapshots/${userId}/${taskId}`
  rmSync(root, { recursive: true, force: true })
  rmSync(snapshotRoot, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["config", "user.name", "test"], { cwd: root })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root })
  writeFileSync(`${root}/tracked.bin`, Buffer.from([0, 1, 2, 3]))
  writeFileSync(`${root}/deleted.txt`, "delete me\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root })
  return { root, snapshotRoot }
}

test("CAS snapshot restores binary, large, executable, symlink, and deleted paths exactly", async t => {
  const taskId = `cas-complete-${Date.now()}`
  const userId = "test-user"
  const { root, snapshotRoot } = initWorkspace(taskId, userId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(snapshotRoot, { recursive: true, force: true })
  })

  const tracked = Buffer.alloc(5 * 1024 * 1024 + 17, 0xa5)
  tracked[0] = 0
  const untracked = Buffer.from([0, 255, 128, 64, 1, 2, 3])
  writeFileSync(`${root}/tracked.bin`, tracked)
  writeFileSync(`${root}/new.bin`, untracked)
  writeFileSync(`${root}/run.sh`, "#!/bin/sh\necho ok\n")
  chmodSync(`${root}/run.sh`, 0o755)
  symlinkSync("tracked.bin", `${root}/latest.bin`)
  rmSync(`${root}/deleted.txt`)

  const created = await createWorkspaceSnapshot(taskId, userId, "complete CAS")
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.snapshot.format, "cas-v1")
  assert.equal(created.snapshot.integrityVerified, true)
  assert.match(created.snapshot.manifestDigest ?? "", /^[a-f0-9]{64}$/)
  assert.match(created.snapshot.treeDigest ?? "", /^[a-f0-9]{64}$/)
  assert.ok(created.snapshot.totalBytes > 5 * 1024 * 1024)
  assert.deepEqual(created.snapshot.createdFiles.sort(), ["latest.bin", "new.bin", "run.sh"])
  assert.deepEqual(created.snapshot.deletedFiles, ["deleted.txt"])

  const chained = await createWorkspaceSnapshot(taskId, userId, "content-addressed parent")
  assert.equal(chained.ok, true)
  if (chained.ok) {
    assert.equal(chained.snapshot.parentSnapshotId, created.snapshot.snapshotId)
    assert.equal(chained.snapshot.parentDigest, created.snapshot.manifestDigest)
    assert.equal(chained.snapshot.head, created.snapshot.head)
  }

  writeFileSync(`${root}/tracked.bin`, "later")
  rmSync(`${root}/new.bin`)
  rmSync(`${root}/run.sh`)
  rmSync(`${root}/latest.bin`)
  writeFileSync(`${root}/later.txt`, "must be cleaned")
  writeFileSync(`${root}/deleted.txt`, "wrong")

  const restored = await restoreWorkspaceSnapshot(taskId, userId, created.snapshot.snapshotId)
  assert.equal(restored.ok, true)
  assert.equal(restored.usedSource, "local_cas")
  assert.deepEqual(readFileSync(`${root}/tracked.bin`), tracked)
  assert.deepEqual(readFileSync(`${root}/new.bin`), untracked)
  assert.equal(readFileSync(`${root}/run.sh`, "utf-8"), "#!/bin/sh\necho ok\n")
  assert.equal(readFileSync(`${root}/latest.bin`, "utf-8"), tracked.toString("utf-8"))
  assert.equal(existsSync(`${root}/deleted.txt`), false)
  assert.equal(existsSync(`${root}/later.txt`), false)
})

test("a corrupted local blob is never reported or restored and validation precedes reset", async t => {
  const taskId = `cas-corrupt-${Date.now()}`
  const userId = "test-user"
  const { root, snapshotRoot } = initWorkspace(taskId, userId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(snapshotRoot, { recursive: true, force: true })
  })
  writeFileSync(`${root}/tracked.bin`, Buffer.from([0, 9, 8, 7]))
  const created = await createWorkspaceSnapshot(taskId, userId, "tamper test")
  assert.equal(created.ok, true)
  if (!created.ok) return
  const manifest = JSON.parse(readFileSync(`${snapshotRoot}/${created.snapshot.snapshotId}.manifest.json`, "utf-8"))
  const digest = manifest.entries.find((entry: { path: string }) => entry.path === "tracked.bin").digest
  writeFileSync(`${snapshotRoot}/blobs/${digest}`, "tampered")
  writeFileSync(`${root}/tracked.bin`, "later workspace value")

  const listed = await listWorkspaceSnapshots(taskId, userId)
  assert.equal(listed.snapshots.some(snapshot => snapshot.snapshotId === created.snapshot.snapshotId && snapshot.restorable), false)
  const restored = await restoreWorkspaceSnapshot(taskId, userId, created.snapshot.snapshotId)
  assert.equal(restored.ok, false)
  assert.match(restored.error ?? "", /校验|损坏/)
  assert.equal(readFileSync(`${root}/tracked.bin`, "utf-8"), "later workspace value")
})

test("manifest tampering is rejected before workspace mutation", async t => {
  const taskId = `cas-manifest-${Date.now()}`
  const userId = "test-user"
  const { root, snapshotRoot } = initWorkspace(taskId, userId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(snapshotRoot, { recursive: true, force: true })
  })
  writeFileSync(`${root}/tracked.bin`, Buffer.from([0, 1, 9]))
  const created = await createWorkspaceSnapshot(taskId, userId, "manifest digest")
  assert.equal(created.ok, true)
  if (!created.ok) return
  const path = `${snapshotRoot}/${created.snapshot.snapshotId}.manifest.json`
  const manifest = JSON.parse(readFileSync(path, "utf-8"))
  manifest.reason = "tampered without recomputing digest"
  writeFileSync(path, JSON.stringify(manifest))
  writeFileSync(`${root}/tracked.bin`, "later value")

  const restored = await restoreWorkspaceSnapshot(taskId, userId, created.snapshot.snapshotId)
  assert.equal(restored.ok, false)
  assert.match(restored.error ?? "", /manifest digest 校验失败/)
  assert.equal(readFileSync(`${root}/tracked.bin`, "utf-8"), "later value")
})

test("oversized files fail explicitly instead of being silently omitted", async t => {
  const taskId = `cas-oversized-${Date.now()}`
  const userId = "test-user"
  const { root, snapshotRoot } = initWorkspace(taskId, userId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(snapshotRoot, { recursive: true, force: true })
  })
  const path = `${root}/oversized.bin`
  writeFileSync(path, "")
  truncateSync(path, 64 * 1024 * 1024 + 1)
  const created = await createWorkspaceSnapshot(taskId, userId, "must reject oversized")
  assert.equal(created.ok, false)
  if (created.ok) return
  assert.match(created.error, /超过 67108864 字节上限，未执行后续修改/)
  assert.equal(existsSync(path), true)
})

test("restore fails closed when repository HEAD moved", async t => {
  const taskId = `cas-head-${Date.now()}`
  const userId = "test-user"
  const { root, snapshotRoot } = initWorkspace(taskId, userId)
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(snapshotRoot, { recursive: true, force: true })
  })
  const created = await createWorkspaceSnapshot(taskId, userId, "head guard")
  assert.equal(created.ok, true)
  if (!created.ok) return
  writeFileSync(`${root}/next.txt`, "next\n")
  execFileSync("git", ["add", "next.txt"], { cwd: root })
  execFileSync("git", ["commit", "-qm", "next"], { cwd: root })

  const restored = await restoreWorkspaceSnapshot(taskId, userId, created.snapshot.snapshotId)
  assert.equal(restored.ok, false)
  assert.match(restored.error ?? "", /HEAD 与 snapshot 不一致/)
  assert.equal(readFileSync(`${root}/next.txt`, "utf-8"), "next\n")
})

function inMemorySupabase(): SupabaseClient {
  const objects = new Map<string, Buffer>()
  const artifacts: Record<string, unknown>[] = []
  class Query implements PromiseLike<{ data: Record<string, unknown>[]; error: null }> {
    private filters: [string, unknown][] = []
    select() { return this }
    eq(key: string, value: unknown) { this.filters.push([key, value]); return this }
    order() { return this }
    limit() { return this }
    then<TResult1 = { data: Record<string, unknown>[]; error: null }, TResult2 = never>(
      resolve?: ((value: { data: Record<string, unknown>[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      const rows = artifacts.filter(row => this.filters.every(([key, value]) => row[key] === value))
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
    }
  }
  return {
    storage: {
      from() {
        return {
          async upload(path: string, value: Buffer) {
            if (objects.has(path)) return { data: null, error: { message: "already exists" } }
            objects.set(path, Buffer.from(value))
            return { data: { path }, error: null }
          },
          async download(path: string) {
            const value = objects.get(path)
            return value
              ? { data: new Blob([value]), error: null }
              : { data: null, error: { message: "missing" } }
          },
        }
      },
    },
    from() {
      return {
        insert(value: Record<string, unknown>) {
          artifacts.push({ ...value, created_at: new Date().toISOString() })
          return Promise.resolve({ error: null })
        },
        select() { return new Query() },
      }
    },
  } as unknown as SupabaseClient
}

test("artifact CAS can restore after all local snapshot state is lost", async t => {
  const taskId = `cas-remote-${Date.now()}`
  const userId = "test-user"
  const { root, snapshotRoot } = initWorkspace(taskId, userId)
  const supabase = inMemorySupabase()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(snapshotRoot, { recursive: true, force: true })
  })
  const exact = Buffer.from([0, 4, 8, 15, 16, 23, 42, 255])
  writeFileSync(`${root}/tracked.bin`, exact)
  const created = await createWorkspaceSnapshot(taskId, userId, "remote CAS", supabase)
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.snapshot.durable, true)
  rmSync(snapshotRoot, { recursive: true, force: true })
  writeFileSync(`${root}/tracked.bin`, "wrong")

  const restored = await restoreWorkspaceSnapshot(taskId, userId, created.snapshot.snapshotId, supabase)
  assert.equal(restored.ok, true)
  assert.equal(restored.usedSource, "artifact_cas")
  assert.deepEqual(readFileSync(`${root}/tracked.bin`), exact)
})
