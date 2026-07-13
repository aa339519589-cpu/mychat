import type { SupabaseClient } from "@supabase/supabase-js"
import { gzipSync, gunzipSync } from "zlib"
import { redactSensitive } from "../path-security"
import type { SnapshotRecord } from "../types"

type ArtifactSnapshotResult =
  | { ok: true; record: SnapshotRecord; patchContent: string }
  | { ok: false; error: string }

export async function persistSnapshotArtifact(
  supabase: SupabaseClient,
  snapshot: SnapshotRecord,
  patchContent: string,
): Promise<boolean> {
  try {
    const safePatch = redactSensitive(patchContent)
    const containsSensitiveContent = safePatch !== patchContent
    const truncated = safePatch.length > 50000
    const contentPatch = truncated ? safePatch.slice(0, 50000) : safePatch
    const compressed = containsSensitiveContent ? null : gzipSync(Buffer.from(patchContent, "utf-8"))
    const canPersistPatch = !!compressed && compressed.byteLength <= 1024 * 1024
    const content = JSON.stringify({
      ...snapshot,
      patchPreview: contentPatch,
      patchTruncated: truncated,
      patchEncoding: canPersistPatch ? "gzip-base64" : null,
      patchData: canPersistPatch ? compressed.toString("base64") : null,
      containsSensitiveContent,
    })

    const { error } = await supabase.from("agent_artifacts").insert({
      id: crypto.randomUUID(),
      task_id: snapshot.taskId,
      user_id: snapshot.userId,
      kind: "summary",
      title: `snapshot:${snapshot.snapshotId}`,
      content,
      meta: {
        snapshotId: snapshot.snapshotId,
        reason: snapshot.reason,
        fileCount: snapshot.changedFiles.length,
        diffSize: snapshot.diffSize,
        changedFiles: snapshot.changedFiles.slice(0, 100),
        createdFiles: snapshot.createdFiles.slice(0, 50),
        modifiedFiles: snapshot.modifiedFiles.slice(0, 50),
        deletedFiles: snapshot.deletedFiles.slice(0, 50),
        restorable: canPersistPatch,
        storage: snapshot.storage,
        workspaceId: snapshot.workspaceId,
        truncated,
      },
    })

    return !error
  } catch {
    return false
  }
}

export async function fetchSnapshotFromArtifact(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  snapshotId: string,
): Promise<ArtifactSnapshotResult> {
  try {
    const { data } = await supabase
      .from("agent_artifacts")
      .select("*")
      .eq("task_id", taskId)
      .eq("user_id", userId)
      .eq("title", `snapshot:${snapshotId}`)
      .limit(1)

    if (!data?.length) return { ok: false, error: `在 agent_artifacts 中未找到 snapshot：${snapshotId}` }

    const artifact = data[0]
    let record: SnapshotRecord
    let patchContent = ""

    try {
      const parsed = JSON.parse(artifact.content ?? "{}")
      record = {
        snapshotId: parsed.snapshotId ?? snapshotId,
        taskId: parsed.taskId ?? taskId,
        userId: parsed.userId ?? userId,
        reason: parsed.reason ?? "",
        changedFiles: parsed.changedFiles ?? [],
        createdFiles: parsed.createdFiles ?? [],
        modifiedFiles: parsed.modifiedFiles ?? [],
        deletedFiles: parsed.deletedFiles ?? [],
        createdAt: parsed.createdAt ?? artifact.created_at ?? "",
        diffSize: parsed.diffSize ?? 0,
        storage: "artifact",
        restorable: parsed.patchEncoding === "gzip-base64"
          ? typeof parsed.patchData === "string"
          : parsed.patchTruncated !== true && typeof parsed.patchPreview === "string",
        workspaceId: parsed.workspaceId ?? null,
      }
      patchContent = parsed.patchEncoding === "gzip-base64" && typeof parsed.patchData === "string"
        ? gunzipSync(Buffer.from(parsed.patchData, "base64")).toString("utf-8")
        : parsed.patchPreview ?? ""
    } catch {
      return { ok: false, error: "Artifact 内容解析失败" }
    }

    if (!record.restorable) {
      return { ok: false, error: "Snapshot artifact 不包含可恢复的 patch 内容（可能过大被截断）" }
    }

    return { ok: true, record, patchContent }
  } catch (error: any) {
    return { ok: false, error: `查询 artifact 失败：${error?.message ?? "未知错误"}` }
  }
}

export async function listSnapshotsFromArtifacts(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<SnapshotRecord[]> {
  try {
    const { data } = await supabase
      .from("agent_artifacts")
      .select("*")
      .eq("task_id", taskId)
      .eq("user_id", userId)
      .eq("kind", "summary")
      .ilike("title", "snapshot:%")
      .order("created_at", { ascending: false })

    return (data ?? []).map((artifact: any) => {
      try {
        const parsed = JSON.parse(artifact.content ?? "{}")
        return {
          snapshotId: parsed.snapshotId ?? artifact.id,
          taskId,
          userId,
          reason: parsed.reason ?? "",
          changedFiles: parsed.changedFiles ?? [],
          createdFiles: parsed.createdFiles ?? [],
          modifiedFiles: parsed.modifiedFiles ?? [],
          deletedFiles: parsed.deletedFiles ?? [],
          createdAt: parsed.createdAt ?? artifact.created_at ?? "",
          diffSize: parsed.diffSize ?? 0,
          storage: "artifact",
          restorable: !!(artifact.meta?.restorable ?? true),
          workspaceId: artifact.meta?.workspaceId ?? null,
        } satisfies SnapshotRecord
      } catch {
        return null
      }
    }).filter(Boolean) as SnapshotRecord[]
  } catch {
    return []
  }
}
