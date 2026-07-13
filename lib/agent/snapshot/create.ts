import { execSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { validatePath } from "../path-security"
import type { SnapshotRecord } from "../types"
import { workspaceRoot } from "../workspace-paths"
import { persistSnapshotArtifact } from "./artifact"
import { hasWorkspaceChanges, parseChangedFiles } from "./diff"
import { snapshotDir } from "./paths"

export type SnapshotResult =
  | { ok: true; snapshot: SnapshotRecord }
  | { ok: false; error: string }

function generateWorkspaceDiff(root: string): string {
  let diff = execSync("git diff --no-color HEAD", {
    cwd: root,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf-8",
  })

  const untracked = execSync("git ls-files --others --exclude-standard", {
    cwd: root,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    encoding: "utf-8",
  }).trim()

  if (!untracked) return diff

  for (const file of untracked.split("\n").filter(Boolean)) {
    try {
      const checked = validatePath(root, file)
      if (!checked.ok) continue
      const content = readFileSync(checked.absolute!, "utf-8")
      const lines = content.split("\n")
      diff += `\ndiff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}\n`
    } catch {
      // Binary and otherwise unreadable untracked files are skipped.
    }
  }

  return diff
}

async function createCleanSnapshot(
  taskId: string,
  userId: string,
  reason: string,
  supabase?: SupabaseClient,
): Promise<SnapshotResult> {
  const snapshotId = crypto.randomUUID()
  const record: SnapshotRecord = {
    snapshotId,
    taskId,
    userId,
    reason,
    changedFiles: [],
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    createdAt: new Date().toISOString(),
    diffSize: 0,
    storage: "local",
    restorable: true,
    workspaceId: null,
  }
  let localOk = false
  try {
    const directory = snapshotDir(taskId, userId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${snapshotId}.patch`), "", "utf-8")
    writeFileSync(join(directory, `${snapshotId}.json`), JSON.stringify(record), "utf-8")
    localOk = true
  } catch {
    // Artifact persistence remains available when local storage fails.
  }
  const artifactOk = supabase ? await persistSnapshotArtifact(supabase, record, "") : false
  if (!localOk && !artifactOk) return { ok: false, error: "Snapshot 本地写入和持久化均失败" }
  record.storage = localOk && artifactOk ? "both" : localOk ? "local" : "artifact"
  return { ok: true, snapshot: record }
}

export async function createWorkspaceSnapshot(
  taskId: string,
  userId: string,
  reason: string,
  supabase?: SupabaseClient,
): Promise<SnapshotResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: `Workspace 不存在：${root}` }

  if (!hasWorkspaceChanges(root)) {
    return createCleanSnapshot(taskId, userId, reason, supabase)
  }

  const snapshotId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  let diff = ""
  try {
    diff = generateWorkspaceDiff(root)
  } catch {
    return { ok: false, error: "生成 diff 失败" }
  }

  if (!diff.trim()) {
    return {
      ok: true,
      snapshot: {
        snapshotId,
        taskId,
        userId,
        reason,
        changedFiles: [],
        createdFiles: [],
        modifiedFiles: [],
        deletedFiles: [],
        createdAt,
        diffSize: 0,
        storage: "local",
        restorable: false,
        workspaceId: null,
      },
    }
  }

  const { changedFiles, createdFiles, modifiedFiles, deletedFiles } = parseChangedFiles(diff)
  let localOk = false
  try {
    const directory = snapshotDir(taskId, userId)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, `${snapshotId}.patch`), diff, "utf-8")
    const metadata = {
      snapshotId,
      taskId,
      userId,
      reason,
      createdAt,
      changedFiles,
      createdFiles,
      modifiedFiles,
      deletedFiles,
      diffSize: diff.length,
      fileCount: changedFiles.length,
    }
    writeFileSync(join(directory, `${snapshotId}.json`), JSON.stringify(metadata), "utf-8")
    localOk = true
  } catch {
    // Artifact persistence remains available when local storage fails.
  }

  const record: SnapshotRecord = {
    snapshotId,
    taskId,
    userId,
    reason,
    changedFiles,
    createdFiles,
    modifiedFiles,
    deletedFiles,
    createdAt,
    diffSize: diff.length,
    storage: localOk ? "both" : "artifact",
    restorable: true,
    workspaceId: null,
  }
  const artifactOk = supabase ? await persistSnapshotArtifact(supabase, record, diff) : false
  if (!localOk && !artifactOk) return { ok: false, error: "Snapshot 本地写入和持久化均失败" }

  record.storage = localOk && artifactOk ? "both" : localOk ? "local" : "artifact"
  return { ok: true, snapshot: record }
}
