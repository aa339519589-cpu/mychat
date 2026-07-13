import { existsSync } from "fs"
import type { SupabaseClient } from "@supabase/supabase-js"
import { errorMessage } from "@/lib/unknown-value"
import type { SnapshotRecord } from "../types"
import { workspaceRoot } from "../workspace-paths"
import { latestArtifactManifest, persistSnapshotArtifact } from "./artifact"
import { captureWorkspaceBundle } from "./cas-capture"
import { recordFromManifest, verifyBundle } from "./cas-integrity"
import { latestLocalManifest, persistLocalBundle, persistLocalRecord } from "./cas-local"

export type SnapshotResult =
  | { ok: true; snapshot: SnapshotRecord }
  | { ok: false; error: string }

export async function createWorkspaceSnapshot(
  taskId: string,
  userId: string,
  reason: string,
  supabase?: SupabaseClient,
): Promise<SnapshotResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: `Workspace 不存在：${root}` }

  try {
    let parent = supabase ? null : latestLocalManifest(taskId, userId)
    if (supabase) {
      const remoteParent = await latestArtifactManifest(supabase, userId, taskId)
      if (!remoteParent.ok) return { ok: false, error: remoteParent.error }
      parent = remoteParent.manifest
    }
    const bundle = captureWorkspaceBundle({
      root,
      snapshotId: crypto.randomUUID(),
      taskId,
      userId,
      reason,
      createdAt: new Date().toISOString(),
      parentSnapshotId: parent?.snapshotId ?? null,
      parentDigest: parent?.manifestDigest ?? null,
    })
    const verified = verifyBundle(bundle)
    if (!verified.ok) return { ok: false, error: verified.error }

    const local = persistLocalBundle(bundle)
    const artifactSeed = recordFromManifest(bundle.manifest, "artifact", true)
    const artifact = supabase
      ? await persistSnapshotArtifact(supabase, artifactSeed, bundle)
      : { ok: false as const, error: "未提供持久化数据库客户端" }

    // Production callers pass Supabase. A merely local /tmp copy is not a durable
    // rollback guarantee, so remote persistence failure blocks the mutation.
    if (supabase && !artifact.ok) {
      return { ok: false, error: `Snapshot durable CAS 持久化失败，拒绝继续：${artifact.error}` }
    }
    if (!supabase && !local.ok) return { ok: false, error: local.error }
    if (!local.ok && !artifact.ok) return { ok: false, error: "Snapshot 没有任何完整可验证的副本" }

    const storage: SnapshotRecord["storage"] = local.ok && artifact.ok
      ? "both"
      : artifact.ok ? "artifact" : "local"
    const record = recordFromManifest(bundle.manifest, storage, artifact.ok)
    if (local.ok) persistLocalRecord(record)
    return { ok: true, snapshot: record }
  } catch (error) {
    return { ok: false, error: `生成 CAS snapshot 失败：${errorMessage(error)}` }
  }
}
