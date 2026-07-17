import type { SupabaseClient } from "@/lib/supabase/types"
import type { RestoreResult, SnapshotRecord } from "../types"
import { listSnapshotsFromArtifacts } from "./artifact"
import { listLocalSnapshotRecords } from "./cas-local"
import { restoreWorkspaceSnapshot } from "./restore"

export async function listWorkspaceSnapshots(
  taskId: string,
  userId: string,
  supabase?: SupabaseClient,
): Promise<{ ok: boolean; snapshots: SnapshotRecord[]; error?: string }> {
  const allSnapshots = new Map(
    listLocalSnapshotRecords(taskId, userId).map(record => [record.snapshotId, record]),
  )

  if (supabase) {
    const artifacts = await listSnapshotsFromArtifacts(supabase, userId, taskId)
    for (const artifact of artifacts) {
      const local = allSnapshots.get(artifact.snapshotId)
      if (!local) {
        allSnapshots.set(artifact.snapshotId, artifact)
        continue
      }
      allSnapshots.set(artifact.snapshotId, {
        ...local,
        storage: "both",
        durable: artifact.durable,
        restorable: local.restorable || artifact.restorable,
        integrityVerified: local.integrityVerified || artifact.integrityVerified,
      })
    }
  }

  const snapshots = [...allSnapshots.values()]
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
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
  if (!latest.restorable || !latest.integrityVerified || latest.format !== "cas-v1") {
    return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: "最近一次 snapshot 未通过完整性校验" }
  }
  return restoreWorkspaceSnapshot(taskId, userId, latest.snapshotId, supabase)
}
