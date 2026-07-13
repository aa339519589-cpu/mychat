import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import type { SnapshotRecord } from "../types"
import { errorMessage } from "@/lib/unknown-value"
import { parseAndVerifyManifest, recordFromManifest, sha256, verifyBundle } from "./cas-integrity"
import type { SnapshotBundle, SnapshotManifest, SnapshotStoreResult } from "./cas-types"
import { snapshotDir } from "./paths"

function manifestPath(taskId: string, userId: string, snapshotId: string): string {
  return join(snapshotDir(taskId, userId), `${snapshotId}.manifest.json`)
}

function blobPath(taskId: string, userId: string, digest: string): string {
  return join(snapshotDir(taskId, userId), "blobs", digest)
}

function writeImmutable(path: string, content: Buffer | string): void {
  if (existsSync(path)) {
    const existing = readFileSync(path)
    const incoming = Buffer.isBuffer(content) ? content : Buffer.from(content)
    if (!existing.equals(incoming)) throw new Error(`不可变 snapshot 对象已存在但内容不同：${path}`)
    return
  }
  const temporary = `${path}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, content, { flag: "wx" })
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    if (!existsSync(path)) throw error
    const existing = readFileSync(path)
    const incoming = Buffer.isBuffer(content) ? content : Buffer.from(content)
    if (!existing.equals(incoming)) throw error
  }
}

export function persistLocalBundle(bundle: SnapshotBundle): SnapshotStoreResult {
  try {
    const { taskId, userId, snapshotId } = bundle.manifest
    const directory = snapshotDir(taskId, userId)
    mkdirSync(join(directory, "blobs"), { recursive: true })
    for (const [digest, blob] of bundle.blobs) {
      if (sha256(blob) !== digest) return { ok: false, error: `本地 blob 写入前校验失败：${digest}` }
      writeImmutable(blobPath(taskId, userId, digest), blob)
      if (sha256(readFileSync(blobPath(taskId, userId, digest))) !== digest) {
        return { ok: false, error: `本地 blob 写入后校验失败：${digest}` }
      }
    }
    writeImmutable(manifestPath(taskId, userId, snapshotId), JSON.stringify(bundle.manifest))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `本地 CAS 持久化失败：${errorMessage(error)}` }
  }
}

export function persistLocalRecord(record: SnapshotRecord): void {
  const path = join(snapshotDir(record.taskId, record.userId), `${record.snapshotId}.json`)
  writeFileSync(path, JSON.stringify(record), "utf-8")
}

export function loadLocalBundle(
  taskId: string,
  userId: string,
  snapshotId: string,
): { ok: true; bundle: SnapshotBundle } | { ok: false; error: string } {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(taskId, userId, snapshotId), "utf-8"))
    const parsed = parseAndVerifyManifest(raw, { taskId, userId, snapshotId })
    if (!parsed.ok) return parsed
    const blobs = new Map<string, Buffer>()
    for (const entry of parsed.manifest.entries) {
      if (!entry.digest || blobs.has(entry.digest)) continue
      const blob = readFileSync(blobPath(taskId, userId, entry.digest))
      blobs.set(entry.digest, blob)
    }
    const bundle = { manifest: parsed.manifest, blobs }
    const verified = verifyBundle(bundle)
    return verified.ok ? { ok: true, bundle } : verified
  } catch (error) {
    return { ok: false, error: `本地 snapshot 不存在或损坏：${errorMessage(error)}` }
  }
}

export function listLocalSnapshotRecords(taskId: string, userId: string): SnapshotRecord[] {
  const directory = snapshotDir(taskId, userId)
  if (!existsSync(directory)) return []
  const records: SnapshotRecord[] = []
  for (const entry of readdirSync(directory).filter(name => name.endsWith(".manifest.json"))) {
    const snapshotId = entry.slice(0, -".manifest.json".length)
    const loaded = loadLocalBundle(taskId, userId, snapshotId)
    if (loaded.ok) records.push(recordFromManifest(loaded.bundle.manifest, "local", false))
  }
  return records
}

export function latestLocalManifest(taskId: string, userId: string): SnapshotManifest | null {
  const directory = snapshotDir(taskId, userId)
  if (!existsSync(directory)) return null
  const manifests: SnapshotManifest[] = []
  for (const entry of readdirSync(directory).filter(name => name.endsWith(".manifest.json"))) {
    const snapshotId = entry.slice(0, -".manifest.json".length)
    const loaded = loadLocalBundle(taskId, userId, snapshotId)
    if (!loaded.ok) throw new Error(`Snapshot parent 链包含损坏对象：${loaded.error}`)
    manifests.push(loaded.bundle.manifest)
  }
  return manifests.sort((left, right) =>
    new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  )[0] ?? null
}
