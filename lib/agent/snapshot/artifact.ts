import type { SupabaseClient } from "@/lib/supabase/types"
import { errorMessage, isRecord } from "@/lib/unknown-value"
import { redactSensitive } from "../path-security"
import type { SnapshotRecord } from "../types"
import { parseAndVerifyManifest, recordFromManifest, sha256, verifyBundle } from "./cas-integrity"
import { SNAPSHOT_BUCKET, type SnapshotBundle, type SnapshotManifest, type SnapshotStoreResult } from "./cas-types"

type ArtifactSnapshotResult =
  | { ok: true; record: SnapshotRecord; bundle: SnapshotBundle }
  | { ok: false; error: string }

function storageSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Snapshot storage 身份段无效")
  return value
}

function blobObjectPath(manifest: SnapshotManifest, digest: string): string {
  return `${storageSegment(manifest.userId)}/${storageSegment(manifest.taskId)}/blobs/${digest}`
}

async function blobBuffer(value: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (typeof Blob !== "undefined" && value instanceof Blob) return Buffer.from(await value.arrayBuffer())
  if (isRecord(value) && typeof value.arrayBuffer === "function") {
    const result = await (value.arrayBuffer as () => Promise<ArrayBuffer>)()
    return Buffer.from(result)
  }
  throw new Error("Storage 返回了未知 blob 类型")
}

async function downloadBlob(
  supabase: SupabaseClient,
  manifest: SnapshotManifest,
  digest: string,
): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(SNAPSHOT_BUCKET).download(blobObjectPath(manifest, digest))
  if (error || !data) throw new Error(error?.message ?? `blob 不存在：${digest}`)
  const blob = await blobBuffer(data)
  if (sha256(blob) !== digest) throw new Error(`远端 blob SHA-256 校验失败：${digest}`)
  return blob
}

function containsSensitiveText(blob: Buffer): boolean {
  const sample = blob.subarray(0, Math.min(blob.byteLength, 8192))
  if (sample.includes(0)) return false
  const text = blob.toString("utf-8")
  return redactSensitive(text) !== text
}

export async function persistSnapshotArtifact(
  supabase: SupabaseClient,
  record: SnapshotRecord,
  bundle: SnapshotBundle,
): Promise<SnapshotStoreResult> {
  try {
    const verified = verifyBundle(bundle)
    if (!verified.ok) return verified
    if ([...bundle.blobs.values()].some(containsSensitiveText)) {
      return { ok: false, error: "Snapshot 包含敏感凭据，拒绝写入未加密的持久化存储" }
    }
    for (const [digest, blob] of bundle.blobs) {
      const path = blobObjectPath(bundle.manifest, digest)
      const uploaded = await supabase.storage.from(SNAPSHOT_BUCKET).upload(path, blob, {
        contentType: "application/octet-stream",
        upsert: false,
      })
      if (uploaded.error) {
        try {
          const existing = await downloadBlob(supabase, bundle.manifest, digest)
          if (!existing.equals(blob)) return { ok: false, error: `远端不可变 blob 冲突：${digest}` }
        } catch {
          return { ok: false, error: `上传 snapshot blob 失败：${uploaded.error.message}` }
        }
      }
      const persisted = await downloadBlob(supabase, bundle.manifest, digest)
      if (persisted.byteLength !== blob.byteLength) return { ok: false, error: `远端 blob 长度校验失败：${digest}` }
    }
    const { error } = await supabase.from("agent_artifacts").insert({
      id: crypto.randomUUID(),
      task_id: record.taskId,
      user_id: record.userId,
      kind: "summary",
      title: `snapshot:${record.snapshotId}`,
      content: JSON.stringify({ format: "cas-v1", manifest: bundle.manifest }),
      meta: {
        snapshotId: record.snapshotId,
        reason: record.reason,
        fileCount: record.entryCount,
        totalBytes: record.totalBytes,
        manifestDigest: record.manifestDigest,
        treeDigest: record.treeDigest,
        parentSnapshotId: record.parentSnapshotId,
        parentDigest: record.parentDigest,
        head: record.head,
        restorable: true,
        integrityVerified: true,
        storage: "artifact",
        workspaceId: record.workspaceId,
      },
    })
    return error ? { ok: false, error: `写入 snapshot manifest artifact 失败：${error.message}` } : { ok: true }
  } catch (error) {
    return { ok: false, error: `持久化 snapshot artifact 失败：${errorMessage(error)}` }
  }
}

function artifactManifest(value: unknown): unknown {
  if (!isRecord(value) || typeof value.content !== "string") return null
  try {
    const content: unknown = JSON.parse(value.content)
    return isRecord(content) && content.format === "cas-v1" ? content.manifest : null
  } catch {
    return null
  }
}

async function hydrateBundle(
  supabase: SupabaseClient,
  manifest: SnapshotManifest,
): Promise<SnapshotBundle> {
  const blobs = new Map<string, Buffer>()
  for (const entry of manifest.entries) {
    if (!entry.digest || blobs.has(entry.digest)) continue
    blobs.set(entry.digest, await downloadBlob(supabase, manifest, entry.digest))
  }
  const bundle = { manifest, blobs }
  const verified = verifyBundle(bundle)
  if (!verified.ok) throw new Error(verified.error)
  return bundle
}

export async function fetchSnapshotFromArtifact(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  snapshotId: string,
): Promise<ArtifactSnapshotResult> {
  try {
    const { data, error } = await supabase
      .from("agent_artifacts")
      .select("*")
      .eq("task_id", taskId)
      .eq("user_id", userId)
      .eq("title", `snapshot:${snapshotId}`)
      .order("created_at", { ascending: false })
      .limit(1)
    if (error) return { ok: false, error: `查询 snapshot artifact 失败：${error.message}` }
    if (!data?.length) return { ok: false, error: `在 agent_artifacts 中未找到 snapshot：${snapshotId}` }
    const parsed = parseAndVerifyManifest(artifactManifest(data[0]), { userId, taskId, snapshotId })
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const bundle = await hydrateBundle(supabase, parsed.manifest)
    return { ok: true, bundle, record: recordFromManifest(parsed.manifest, "artifact", true) }
  } catch (error) {
    return { ok: false, error: `读取 snapshot artifact 失败：${errorMessage(error)}` }
  }
}

export async function latestArtifactManifest(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<{ ok: true; manifest: SnapshotManifest | null } | { ok: false; error: string }> {
  try {
    const { data, error } = await supabase.from("agent_artifacts").select("*")
      .eq("task_id", taskId).eq("user_id", userId).eq("kind", "summary")
      .order("created_at", { ascending: false }).limit(50)
    if (error) return { ok: false, error: `查询 snapshot parent 失败：${error.message}` }
    for (const artifact of data ?? []) {
      if (!isRecord(artifact) || typeof artifact.content !== "string") continue
      let content: unknown
      try { content = JSON.parse(artifact.content) } catch { continue }
      if (!isRecord(content) || content.format !== "cas-v1") continue
      const parsed = parseAndVerifyManifest(content.manifest, { userId, taskId })
      if (!parsed.ok) return { ok: false, error: `最新 CAS parent 损坏：${parsed.error}` }
      await hydrateBundle(supabase, parsed.manifest)
      return { ok: true, manifest: parsed.manifest }
    }
    return { ok: true, manifest: null }
  } catch (error) {
    return { ok: false, error: `验证 snapshot parent 失败：${errorMessage(error)}` }
  }
}

function invalidArtifactRecord(value: unknown, userId: string, taskId: string): SnapshotRecord | null {
  if (!isRecord(value)) return null
  const title = typeof value.title === "string" ? value.title : ""
  if (!title.startsWith("snapshot:")) return null
  return {
    snapshotId: title.slice("snapshot:".length) || String(value.id ?? "unknown"), taskId, userId,
    reason: "", changedFiles: [], createdFiles: [], modifiedFiles: [], deletedFiles: [],
    createdAt: typeof value.created_at === "string" ? value.created_at : "", diffSize: 0,
    storage: "artifact", restorable: false, workspaceId: null, format: "legacy-patch", head: null,
    parentSnapshotId: null, parentDigest: null, treeDigest: null, manifestDigest: null,
    entryCount: 0, totalBytes: 0, integrityVerified: false, durable: false,
  }
}

export async function listSnapshotsFromArtifacts(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<SnapshotRecord[]> {
  try {
    const { data } = await supabase.from("agent_artifacts").select("*")
      .eq("task_id", taskId).eq("user_id", userId).eq("kind", "summary")
      .ilike("title", "snapshot:%").order("created_at", { ascending: false })
    const records: SnapshotRecord[] = []
    for (const artifact of data ?? []) {
      const parsed = parseAndVerifyManifest(artifactManifest(artifact), { userId, taskId })
      if (!parsed.ok) {
        const invalid = invalidArtifactRecord(artifact, userId, taskId)
        if (invalid) records.push(invalid)
        continue
      }
      // Listing is metadata-only. Hydration and every blob digest are verified
      // immediately before restore; a GET must not download the whole workspace.
      records.push(recordFromManifest(parsed.manifest, "artifact", true))
    }
    return records
  } catch {
    return []
  }
}
