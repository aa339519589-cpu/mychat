export const SNAPSHOT_SCHEMA_VERSION = 1 as const
export const SNAPSHOT_SCOPE = "git-working-tree" as const
export const MAX_SNAPSHOT_BLOB_BYTES = 64 * 1024 * 1024
export const MAX_SNAPSHOT_TOTAL_BYTES = 256 * 1024 * 1024
export const MAX_SNAPSHOT_ENTRIES = 10_000
export const MAX_SNAPSHOT_MANIFEST_BYTES = 4 * 1024 * 1024
export const SNAPSHOT_BUCKET = "agent-snapshots"

export type SnapshotEntry = {
  path: string
  kind: "file" | "symlink" | "deleted"
  change: "created" | "modified" | "deleted"
  mode: number | null
  size: number
  digest: string | null
}

export type SnapshotManifest = {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  scope: typeof SNAPSHOT_SCOPE
  snapshotId: string
  taskId: string
  userId: string
  reason: string
  createdAt: string
  head: string
  parentSnapshotId: string | null
  parentDigest: string | null
  entries: SnapshotEntry[]
  treeDigest: string
  manifestDigest: string
}

export type SnapshotBundle = {
  manifest: SnapshotManifest
  blobs: Map<string, Buffer>
}

export type SnapshotStoreResult =
  | { ok: true }
  | { ok: false; error: string }
