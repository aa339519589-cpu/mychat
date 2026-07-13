import { createHash } from "crypto"
import { isRecord } from "@/lib/unknown-value"
import type { SnapshotRecord } from "../types"
import {
  MAX_SNAPSHOT_BLOB_BYTES,
  MAX_SNAPSHOT_ENTRIES,
  MAX_SNAPSHOT_MANIFEST_BYTES,
  MAX_SNAPSHOT_TOTAL_BYTES,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_SCOPE,
  type SnapshotBundle,
  type SnapshotEntry,
  type SnapshotManifest,
} from "./cas-types"

const SHA256 = /^[a-f0-9]{64}$/
const GIT_HEAD = /^[a-f0-9]{40,64}$/

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]),
  )
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export function computeTreeDigest(entries: SnapshotEntry[]): string {
  return sha256(canonicalJson(entries))
}

export function computeManifestDigest(manifest: Omit<SnapshotManifest, "manifestDigest">): string {
  return sha256(canonicalJson(manifest))
}

function validSnapshotPath(path: string): boolean {
  if (!path || path.length > 4096 || path.startsWith("/") || path.includes("\0")) return false
  const parts = path.split("/")
  const lower = parts.map(part => part.toLowerCase())
  const forbiddenDirectories = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".cache"])
  const forbiddenNames = new Set([".env", ".env.local", ".env.production", ".env.development", ".env.staging", ".npmrc", ".netrc"])
  const forbiddenSuffixes = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".secret"]
  return !parts.some(part => !part || part === "." || part === "..")
    && !lower.some(part => forbiddenDirectories.has(part) || forbiddenNames.has(part))
    && !lower.some(part => part.startsWith(".env.") && !part.endsWith(".example") && !part.endsWith(".sample"))
    && !forbiddenSuffixes.some(suffix => lower.at(-1)?.endsWith(suffix))
}

function parseEntry(value: unknown): SnapshotEntry | null {
  if (!isRecord(value) || typeof value.path !== "string" || !validSnapshotPath(value.path)) return null
  if (value.kind !== "file" && value.kind !== "symlink" && value.kind !== "deleted") return null
  if (value.change !== "created" && value.change !== "modified" && value.change !== "deleted") return null
  if (!Number.isSafeInteger(value.size) || Number(value.size) < 0) return null
  const size = Number(value.size)
  if (value.kind === "deleted") {
    if (value.change !== "deleted" || value.digest !== null || value.mode !== null || size !== 0) return null
    return { path: value.path, kind: value.kind, change: value.change, mode: null, size: 0, digest: null }
  }
  if (value.change === "deleted") return null
  if (typeof value.digest !== "string" || !SHA256.test(value.digest)) return null
  if (!Number.isSafeInteger(value.mode) || Number(value.mode) < 0 || Number(value.mode) > 0o777) return null
  if (size > MAX_SNAPSHOT_BLOB_BYTES) return null
  return { path: value.path, kind: value.kind, change: value.change, mode: Number(value.mode), size, digest: value.digest }
}

export function parseAndVerifyManifest(
  value: unknown,
  expected?: { snapshotId?: string; taskId?: string; userId?: string },
): { ok: true; manifest: SnapshotManifest } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "Snapshot manifest 不是对象" }
  if (value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION || value.scope !== SNAPSHOT_SCOPE) {
    return { ok: false, error: "Snapshot manifest 版本或作用域不受支持" }
  }
  const strings = ["snapshotId", "taskId", "userId", "reason", "createdAt", "head", "treeDigest", "manifestDigest"] as const
  if (strings.some(key => typeof value[key] !== "string")) return { ok: false, error: "Snapshot manifest 字段不完整" }
  if (!value.snapshotId || String(value.snapshotId).length > 200
    || !value.taskId || String(value.taskId).length > 200
    || !value.userId || String(value.userId).length > 200
    || String(value.reason).length > 10_000 || !GIT_HEAD.test(String(value.head))) {
    return { ok: false, error: "Snapshot manifest 身份或 HEAD 无效" }
  }
  if (!SHA256.test(String(value.treeDigest)) || !SHA256.test(String(value.manifestDigest))) {
    return { ok: false, error: "Snapshot manifest digest 格式无效" }
  }
  if (value.parentSnapshotId !== null && typeof value.parentSnapshotId !== "string") {
    return { ok: false, error: "Snapshot parentSnapshotId 无效" }
  }
  if (value.parentDigest !== null && (typeof value.parentDigest !== "string" || !SHA256.test(value.parentDigest))) {
    return { ok: false, error: "Snapshot parentDigest 无效" }
  }
  if ((value.parentSnapshotId === null) !== (value.parentDigest === null)) {
    return { ok: false, error: "Snapshot parent 链不完整" }
  }
  if (!Array.isArray(value.entries)) return { ok: false, error: "Snapshot entries 无效" }
  if (value.entries.length > MAX_SNAPSHOT_ENTRIES) return { ok: false, error: "Snapshot 文件数量超过安全上限" }
  const entries: SnapshotEntry[] = []
  const paths = new Set<string>()
  let totalBytes = 0
  for (const raw of value.entries) {
    const entry = parseEntry(raw)
    if (!entry || paths.has(entry.path)) return { ok: false, error: "Snapshot entry 无效或路径重复" }
    paths.add(entry.path)
    totalBytes += entry.size
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) return { ok: false, error: "Snapshot 总大小超过安全上限" }
    entries.push(entry)
  }
  if (entries.some((entry, index) => index > 0 && entries[index - 1]!.path >= entry.path)) {
    return { ok: false, error: "Snapshot entries 未按路径规范排序" }
  }
  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    scope: SNAPSHOT_SCOPE,
    snapshotId: String(value.snapshotId),
    taskId: String(value.taskId),
    userId: String(value.userId),
    reason: String(value.reason),
    createdAt: String(value.createdAt),
    head: String(value.head),
    parentSnapshotId: value.parentSnapshotId as string | null,
    parentDigest: value.parentDigest as string | null,
    entries,
    treeDigest: String(value.treeDigest),
    manifestDigest: String(value.manifestDigest),
  }
  if (Buffer.byteLength(canonicalJson(manifest), "utf-8") > MAX_SNAPSHOT_MANIFEST_BYTES) {
    return { ok: false, error: "Snapshot manifest 超过安全上限" }
  }
  if (expected?.snapshotId && manifest.snapshotId !== expected.snapshotId) return { ok: false, error: "Snapshot ID 不匹配" }
  if (expected?.taskId && manifest.taskId !== expected.taskId) return { ok: false, error: "Snapshot task 归属不匹配" }
  if (expected?.userId && manifest.userId !== expected.userId) return { ok: false, error: "Snapshot user 归属不匹配" }
  if (computeTreeDigest(entries) !== manifest.treeDigest) return { ok: false, error: "Snapshot tree digest 校验失败" }
  const { manifestDigest: _digest, ...unsigned } = manifest
  if (computeManifestDigest(unsigned) !== manifest.manifestDigest) return { ok: false, error: "Snapshot manifest digest 校验失败" }
  return { ok: true, manifest }
}

export function verifyBundle(bundle: SnapshotBundle): { ok: true } | { ok: false; error: string } {
  const parsed = parseAndVerifyManifest(bundle.manifest)
  if (!parsed.ok) return parsed
  for (const entry of parsed.manifest.entries) {
    if (!entry.digest) continue
    const blob = bundle.blobs.get(entry.digest)
    if (!blob) return { ok: false, error: `Snapshot blob 缺失：${entry.path}` }
    if (blob.byteLength !== entry.size || sha256(blob) !== entry.digest) {
      return { ok: false, error: `Snapshot blob SHA-256 校验失败：${entry.path}` }
    }
  }
  return { ok: true }
}

export function recordFromManifest(
  manifest: SnapshotManifest,
  storage: SnapshotRecord["storage"],
  durable: boolean,
  integrityVerified = true,
): SnapshotRecord {
  const createdFiles = manifest.entries.filter(entry => entry.change === "created").map(entry => entry.path)
  const modifiedFiles = manifest.entries.filter(entry => entry.change === "modified").map(entry => entry.path)
  const deletedFiles = manifest.entries.filter(entry => entry.change === "deleted").map(entry => entry.path)
  return {
    snapshotId: manifest.snapshotId,
    taskId: manifest.taskId,
    userId: manifest.userId,
    reason: manifest.reason,
    changedFiles: manifest.entries.map(entry => entry.path),
    createdFiles,
    modifiedFiles,
    deletedFiles,
    createdAt: manifest.createdAt,
    diffSize: manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
    storage,
    restorable: integrityVerified,
    workspaceId: null,
    format: "cas-v1",
    head: manifest.head,
    parentSnapshotId: manifest.parentSnapshotId,
    parentDigest: manifest.parentDigest,
    treeDigest: manifest.treeDigest,
    manifestDigest: manifest.manifestDigest,
    entryCount: manifest.entries.length,
    totalBytes: manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
    integrityVerified,
    durable,
  }
}
