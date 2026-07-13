import { posix } from "node:path"
import { Buffer } from "node:buffer"
import { MAX_ISOLATED_FILE_BYTES } from "./isolated-files"

export const ISOLATED_SYNC_VERSION = 1 as const
export const MAX_ISOLATED_SYNC_FILES = 10_000
export const MAX_ISOLATED_SYNC_BYTES = 50 * 1024 * 1024
export const MAX_ISOLATED_MANIFEST_BYTES = 2 * 1024 * 1024
export const MAX_ISOLATED_SYNC_PATH_BYTES = 512

const SHA256 = /^[a-f0-9]{64}$/
const FORBIDDEN_DIRECTORIES = new Set([
  ".git", ".next", ".turbo", "__pycache__", "bower_components", "build",
  "coverage", "dist", "node_modules", "vendor", ".cache",
])
const FORBIDDEN_FILES = new Set([
  ".env", ".env.development", ".env.local", ".env.production", ".env.staging",
  ".netrc", ".npmrc", ".pypirc", ".yarnrc.yml",
])
const FORBIDDEN_SUFFIXES = [".jks", ".key", ".keystore", ".p12", ".pem", ".pfx", ".secret"]

export type IsolatedSyncFile = {
  sha256: string
  size: number
}

export type IsolatedSyncManifest = {
  version: typeof ISOLATED_SYNC_VERSION
  files: Record<string, IsolatedSyncFile>
}

export type IsolatedHydrationPlan = {
  initial: boolean
  uploads: string[]
  deletes: string[]
  manifest: IsolatedSyncManifest
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/** Validate a POSIX workspace-relative file path without consulting either filesystem. */
export function validateIsolatedSyncPath(rawPath: string): string {
  if (typeof rawPath !== "string" || !rawPath || rawPath !== rawPath.trim()) {
    throw new Error("同步路径为空或包含首尾空白")
  }
  if (Buffer.byteLength(rawPath, "utf8") > MAX_ISOLATED_SYNC_PATH_BYTES) {
    throw new Error("同步路径超过长度上限")
  }
  if (rawPath.startsWith("/") || rawPath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(rawPath)) {
    throw new Error(`同步路径格式非法：${rawPath}`)
  }
  if (rawPath.normalize("NFC") !== rawPath || posix.normalize(rawPath) !== rawPath) {
    throw new Error(`同步路径不是规范路径：${rawPath}`)
  }

  const segments = rawPath.split("/")
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`同步路径包含非法段：${rawPath}`)
  }

  for (const segment of segments) {
    const lower = segment.toLowerCase()
    const privateEnv = lower.startsWith(".env.")
      && !lower.endsWith(".example")
      && !lower.endsWith(".sample")
    if (FORBIDDEN_DIRECTORIES.has(lower) || FORBIDDEN_FILES.has(lower) || privateEnv) {
      throw new Error(`同步路径指向受保护内容：${rawPath}`)
    }
  }

  const lowerPath = rawPath.toLowerCase()
  if (lowerPath.endsWith(".docker/config.json") || FORBIDDEN_SUFFIXES.some(suffix => lowerPath.endsWith(suffix))) {
    throw new Error(`同步路径指向敏感文件：${rawPath}`)
  }
  return rawPath
}

function normalizeManifest(value: unknown): IsolatedSyncManifest {
  if (!record(value) || !exactKeys(value, ["files", "version"]) || value.version !== ISOLATED_SYNC_VERSION) {
    throw new Error("隔离同步 manifest 版本或结构非法")
  }
  if (!record(value.files)) throw new Error("隔离同步 manifest files 非法")

  const paths = Object.keys(value.files).sort()
  if (paths.length > MAX_ISOLATED_SYNC_FILES) throw new Error("隔离同步 manifest 文件数超限")

  let totalBytes = 0
  const files: Record<string, IsolatedSyncFile> = {}
  for (const path of paths) {
    validateIsolatedSyncPath(path)
    const entry = value.files[path]
    if (!record(entry) || !exactKeys(entry, ["sha256", "size"])) {
      throw new Error(`隔离同步 manifest 文件项非法：${path}`)
    }
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      throw new Error(`隔离同步 manifest 摘要非法：${path}`)
    }
    if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0 || Number(entry.size) > MAX_ISOLATED_FILE_BYTES) {
      throw new Error(`隔离同步 manifest 文件大小非法：${path}`)
    }
    totalBytes += Number(entry.size)
    if (totalBytes > MAX_ISOLATED_SYNC_BYTES) throw new Error("隔离同步 manifest 总大小超限")
    files[path] = { sha256: entry.sha256, size: Number(entry.size) }
  }
  return { version: ISOLATED_SYNC_VERSION, files }
}

export function createIsolatedSyncManifest(
  entries: Iterable<{ path: string; sha256: string; size: number }>,
): IsolatedSyncManifest {
  const files: Record<string, IsolatedSyncFile> = {}
  for (const entry of entries) {
    const path = validateIsolatedSyncPath(entry.path)
    if (files[path]) throw new Error(`隔离同步 manifest 路径重复：${path}`)
    files[path] = { sha256: entry.sha256, size: entry.size }
  }
  return normalizeManifest({ version: ISOLATED_SYNC_VERSION, files })
}

export function serializeIsolatedSyncManifest(manifest: IsolatedSyncManifest): string {
  const normalized = normalizeManifest(manifest)
  const text = `${JSON.stringify(normalized)}\n`
  if (Buffer.byteLength(text, "utf8") > MAX_ISOLATED_MANIFEST_BYTES) {
    throw new Error("隔离同步 manifest 内容过大")
  }
  return text
}

export function parseIsolatedSyncManifest(text: string): IsolatedSyncManifest {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_ISOLATED_MANIFEST_BYTES) {
    throw new Error("隔离同步 manifest 内容过大或格式非法")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("隔离同步 manifest 不是合法 JSON")
  }
  const manifest = normalizeManifest(parsed)
  if (serializeIsolatedSyncManifest(manifest) !== text) {
    throw new Error("隔离同步 manifest 不是规范编码")
  }
  return manifest
}

export function planIsolatedWorkspaceHydration(
  localValue: IsolatedSyncManifest,
  remoteValue: IsolatedSyncManifest | null,
): IsolatedHydrationPlan {
  const local = normalizeManifest(localValue)
  const remote = remoteValue === null ? null : normalizeManifest(remoteValue)
  const uploads = Object.keys(local.files).filter(path => {
    const current = remote?.files[path]
    return !current || current.sha256 !== local.files[path].sha256 || current.size !== local.files[path].size
  })
  const deletes = remote
    ? Object.keys(remote.files).filter(path => !local.files[path])
    : []
  return {
    initial: remote === null,
    uploads: uploads.sort(),
    deletes: deletes.sort(),
    manifest: local,
  }
}
