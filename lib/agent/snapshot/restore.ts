import { execFileSync } from "child_process"
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs"
import type { Stats } from "fs"
import { dirname } from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { errorMessage } from "@/lib/unknown-value"
import type { RestoreResult } from "../types"
import { workspaceRoot } from "../workspace-paths"
import { fetchSnapshotFromArtifact } from "./artifact"
import { resolveSnapshotPath } from "./cas-capture"
import { sha256, verifyBundle } from "./cas-integrity"
import { loadLocalBundle } from "./cas-local"
import type { SnapshotBundle, SnapshotEntry } from "./cas-types"

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf-8",
  })
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path) as Stats } catch { return null }
}

function applyEntry(root: string, entry: SnapshotEntry, blobs: Map<string, Buffer>): void {
  const absolute = resolveSnapshotPath(root, entry.path)
  if (entry.kind === "deleted") {
    rmSync(absolute, { recursive: true, force: true })
    return
  }
  const blob = entry.digest ? blobs.get(entry.digest) : undefined
  if (!blob || !entry.digest || sha256(blob) !== entry.digest || blob.byteLength !== entry.size) {
    throw new Error(`Snapshot blob 在应用前校验失败：${entry.path}`)
  }
  mkdirSync(dirname(absolute), { recursive: true })
  rmSync(absolute, { recursive: true, force: true })
  if (entry.kind === "symlink") {
    const target = blob.toString("utf-8")
    if (!target || target.includes("\0")) throw new Error(`Snapshot 符号链接内容无效：${entry.path}`)
    symlinkSync(target, absolute)
    return
  }
  writeFileSync(absolute, blob, { flag: "wx" })
  chmodSync(absolute, entry.mode ?? 0o644)
}

function verifyRestoredEntry(root: string, entry: SnapshotEntry): boolean {
  const absolute = resolveSnapshotPath(root, entry.path)
  const stat = lstatOrNull(absolute)
  if (entry.kind === "deleted") return stat === null
  if (!stat || !entry.digest) return false
  let blob: Buffer
  if (entry.kind === "symlink") {
    if (!stat.isSymbolicLink()) return false
    blob = Buffer.from(readlinkSync(absolute), "utf-8")
  } else {
    if (!stat.isFile()) return false
    blob = readFileSync(absolute)
    if ((stat.mode & 0o777) !== entry.mode) return false
  }
  return blob.byteLength === entry.size && sha256(blob) === entry.digest
}

function applyBundle(root: string, bundle: SnapshotBundle): { restored: number; failed: number } {
  const verified = verifyBundle(bundle)
  if (!verified.ok) throw new Error(verified.error)
  const currentHead = git(root, ["rev-parse", "--verify", "HEAD"]).trim()
  if (currentHead !== bundle.manifest.head) {
    throw new Error(`Workspace HEAD 与 snapshot 不一致（当前 ${currentHead}，snapshot ${bundle.manifest.head}）`)
  }
  // Source integrity and HEAD are checked before the first destructive operation.
  git(root, ["reset", "--hard", "HEAD"])
  git(root, ["clean", "-ffd"])
  let restored = 0
  for (const entry of bundle.manifest.entries) {
    applyEntry(root, entry, bundle.blobs)
    restored++
  }
  let failed = 0
  for (const entry of bundle.manifest.entries) {
    if (!verifyRestoredEntry(root, entry)) failed++
  }
  if (failed) throw new Error(`Snapshot 恢复后逐项 SHA-256 校验失败：${failed} 个路径`)
  return { restored, failed: 0 }
}

export async function restoreWorkspaceSnapshot(
  taskId: string,
  userId: string,
  snapshotId: string,
  supabase?: SupabaseClient,
): Promise<RestoreResult> {
  const root = workspaceRoot(taskId, userId)
  if (!lstatOrNull(root)) {
    return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: "Workspace 不存在" }
  }

  const local = loadLocalBundle(taskId, userId, snapshotId)
  const localError = local.ok ? "" : local.error
  let bundle: SnapshotBundle | null = local.ok ? local.bundle : null
  let source: RestoreResult["usedSource"] = local.ok ? "local_cas" : "none"
  let artifactError = ""
  if (!bundle && supabase) {
    const artifact = await fetchSnapshotFromArtifact(supabase, userId, taskId, snapshotId)
    if (artifact.ok) {
      bundle = artifact.bundle
      source = "artifact_cas"
    } else {
      artifactError = artifact.error
    }
  }
  if (!bundle) {
    const details = [localError, artifactError].filter(Boolean).join("；")
    return {
      ok: false, snapshotId, restoredFiles: 0, failedFiles: 0, usedSource: "none",
      error: `Snapshot 没有完整且通过摘要校验的副本：${details}`,
    }
  }

  try {
    const result = applyBundle(root, bundle)
    return { ok: true, snapshotId, restoredFiles: result.restored, failedFiles: 0, usedSource: source }
  } catch (error) {
    return {
      ok: false, snapshotId, restoredFiles: 0, failedFiles: bundle.manifest.entries.length,
      usedSource: "none", error: `恢复失败（未降级到无摘要 patch）：${errorMessage(error)}`,
    }
  }
}
