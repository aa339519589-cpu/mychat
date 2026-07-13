import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { RestoreResult, SnapshotRecord } from "../types"
import { workspaceRoot } from "../workspace-paths"
import { listSnapshotsFromArtifacts } from "./artifact"
import { snapshotDir } from "./paths"
import { restoreWorkspaceSnapshot } from "./restore"

function readLocalSnapshots(taskId: string, userId: string): Map<string, SnapshotRecord> {
  const snapshots = new Map<string, SnapshotRecord>()
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return snapshots

  const directory = snapshotDir(taskId, userId)
  if (!existsSync(directory)) return snapshots

  try {
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".json")) continue
      try {
        const metadata = JSON.parse(readFileSync(join(directory, entry), "utf-8"))
        const patchPath = join(directory, entry.replace(/\.json$/, ".patch"))
        const snapshotId = metadata.snapshotId || metadata.id
        snapshots.set(snapshotId, {
          snapshotId,
          taskId,
          userId,
          reason: metadata.reason ?? "",
          changedFiles: metadata.changedFiles ?? [],
          createdFiles: metadata.createdFiles ?? [],
          modifiedFiles: metadata.modifiedFiles ?? [],
          deletedFiles: metadata.deletedFiles ?? [],
          createdAt: metadata.createdAt ?? "",
          diffSize: metadata.diffSize ?? 0,
          storage: "local",
          restorable: existsSync(patchPath),
          workspaceId: null,
        })
      } catch {
        // Corrupt local metadata does not hide other snapshots.
      }
    }
  } catch {
    // An unreadable local directory is treated as empty.
  }
  return snapshots
}

export async function listWorkspaceSnapshots(
  taskId: string,
  userId: string,
  supabase?: SupabaseClient,
): Promise<{ ok: boolean; snapshots: SnapshotRecord[]; error?: string }> {
  const allSnapshots = readLocalSnapshots(taskId, userId)

  if (supabase) {
    const artifacts = await listSnapshotsFromArtifacts(supabase, userId, taskId)
    for (const artifact of artifacts) {
      if (!allSnapshots.has(artifact.snapshotId)) {
        artifact.storage = "artifact"
        allSnapshots.set(artifact.snapshotId, artifact)
      } else {
        allSnapshots.get(artifact.snapshotId)!.storage = "both"
      }
    }
  }

  const snapshots = [...allSnapshots.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return { ok: true, snapshots }
}

export async function revertLastWorkspaceChange(
  taskId: string,
  userId: string,
  supabase?: SupabaseClient,
): Promise<RestoreResult> {
  const list = await listWorkspaceSnapshots(taskId, userId, supabase)
  if (!list.ok) {
    return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: list.error }
  }
  if (!list.snapshots.length) {
    return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: "没有可用的 snapshot" }
  }

  const latest = list.snapshots[0]
  if (!latest.restorable) {
    return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: "最近一次 snapshot 不可恢复" }
  }
  return restoreWorkspaceSnapshot(taskId, userId, latest.snapshotId, supabase)
}
