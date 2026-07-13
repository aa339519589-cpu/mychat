import { execFileSync } from "child_process"
import { lstatSync, readFileSync, readlinkSync } from "fs"
import { relative, resolve, sep } from "path"
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
import { computeManifestDigest, computeTreeDigest, sha256 } from "./cas-integrity"

type Change = "created" | "modified" | "deleted"

const FORBIDDEN_SEGMENTS = new Set([".env", ".env.local", ".env.production", ".env.development", ".env.staging", ".npmrc", ".netrc"])
const FORBIDDEN_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".cache"])
const FORBIDDEN_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".secret"]

function git(root: string, args: string[], maxBuffer = 4 * 1024 * 1024): string {
  return execFileSync("git", args, {
    cwd: root,
    timeout: 30_000,
    maxBuffer,
    encoding: "utf-8",
  })
}

function changedPaths(root: string): Map<string, Change> {
  const changes = new Map<string, Change>()
  const tracked = git(root, ["diff", "--name-status", "--no-renames", "-z", "HEAD", "--"])
    .split("\0")
  for (let index = 0; index < tracked.length - 1; index += 2) {
    const status = tracked[index]
    const path = tracked[index + 1]
    if (!status || !path) continue
    if (status.includes("U")) throw new Error(`存在未解决的 Git 冲突，无法生成完整 snapshot：${path}`)
    changes.set(path, status === "A" ? "created" : status === "D" ? "deleted" : "modified")
  }
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"], 16 * 1024 * 1024)
  for (const path of untracked.split("\0").filter(Boolean)) {
    if (!changes.has(path)) changes.set(path, "created")
  }
  return changes
}

export function resolveSnapshotPath(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\0")) throw new Error(`Snapshot 路径无效：${path}`)
  const parts = path.split("/")
  const lowerParts = parts.map(part => part.toLowerCase())
  const privateEnv = lowerParts.some(part => part.startsWith(".env.") && !part.endsWith(".example") && !part.endsWith(".sample"))
  const forbiddenSuffix = FORBIDDEN_SUFFIXES.some(suffix => lowerParts.at(-1)?.endsWith(suffix))
  if (parts.some(part => !part || part === "." || part === "..")
    || lowerParts.some(part => FORBIDDEN_DIRECTORIES.has(part) || FORBIDDEN_SEGMENTS.has(part))
    || privateEnv || forbiddenSuffix) {
    throw new Error(`Snapshot 路径越界或受保护：${path}`)
  }
  const absolute = resolve(root, ...parts)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) throw new Error(`Snapshot 路径越界：${path}`)
  let parent = root
  for (const part of parts.slice(0, -1)) {
    parent = resolve(parent, part)
    try {
      if (lstatSync(parent).isSymbolicLink()) throw new Error(`Snapshot 路径经过符号链接：${path}`)
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      if (code !== "ENOENT") throw error
    }
  }
  return absolute
}

function captureEntry(root: string, path: string, change: Change): { entry: SnapshotEntry; blob?: Buffer } {
  const absolute = resolveSnapshotPath(root, path)
  if (change === "deleted") {
    return { entry: { path, kind: "deleted", change, mode: null, size: 0, digest: null } }
  }
  const stat = lstatSync(absolute)
  let blob: Buffer
  let kind: SnapshotEntry["kind"]
  if (stat.isFile()) {
    if (stat.size > MAX_SNAPSHOT_BLOB_BYTES) {
      throw new Error(`Snapshot 文件超过 ${MAX_SNAPSHOT_BLOB_BYTES} 字节上限，未执行后续修改：${path}`)
    }
    blob = readFileSync(absolute)
    kind = "file"
  } else if (stat.isSymbolicLink()) {
    blob = Buffer.from(readlinkSync(absolute), "utf-8")
    kind = "symlink"
  } else {
    throw new Error(`Snapshot 不支持该文件类型，未静默遗漏：${path}`)
  }
  const digest = sha256(blob)
  return {
    entry: { path, kind, change, mode: stat.mode & 0o777, size: blob.byteLength, digest },
    blob,
  }
}

export function captureWorkspaceBundle(input: {
  root: string
  snapshotId: string
  taskId: string
  userId: string
  reason: string
  createdAt: string
  parentSnapshotId: string | null
  parentDigest: string | null
}): SnapshotBundle {
  const head = git(input.root, ["rev-parse", "--verify", "HEAD"]).trim()
  const entries: SnapshotEntry[] = []
  const blobs = new Map<string, Buffer>()
  let totalBytes = 0
  const changes = [...changedPaths(input.root).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  if (changes.length > MAX_SNAPSHOT_ENTRIES) {
    throw new Error(`Snapshot 文件数超过 ${MAX_SNAPSHOT_ENTRIES} 上限，未执行后续修改`)
  }
  for (const [path, change] of changes) {
    const captured = captureEntry(input.root, path, change)
    entries.push(captured.entry)
    if (!captured.blob || !captured.entry.digest) continue
    totalBytes += captured.blob.byteLength
    if (totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new Error(`Snapshot 总大小超过 ${MAX_SNAPSHOT_TOTAL_BYTES} 字节上限，未执行后续修改`)
    }
    const existing = blobs.get(captured.entry.digest)
    if (existing && !existing.equals(captured.blob)) throw new Error("Snapshot SHA-256 碰撞，拒绝继续")
    blobs.set(captured.entry.digest, captured.blob)
  }
  const unsigned: Omit<SnapshotManifest, "manifestDigest"> = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    scope: SNAPSHOT_SCOPE,
    snapshotId: input.snapshotId,
    taskId: input.taskId,
    userId: input.userId,
    reason: input.reason,
    createdAt: input.createdAt,
    head,
    parentSnapshotId: input.parentSnapshotId,
    parentDigest: input.parentDigest,
    entries,
    treeDigest: computeTreeDigest(entries),
  }
  const manifest = { ...unsigned, manifestDigest: computeManifestDigest(unsigned) }
  if (Buffer.byteLength(JSON.stringify(manifest), "utf-8") > MAX_SNAPSHOT_MANIFEST_BYTES) {
    throw new Error(`Snapshot manifest 超过 ${MAX_SNAPSHOT_MANIFEST_BYTES} 字节上限，未执行后续修改`)
  }
  return { manifest, blobs }
}
