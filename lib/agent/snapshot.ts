// Snapshot / Rollback：持久化到 agent_artifacts + 本地 patch + 3-tier 恢复
// 每次 write/edit/delete/apply_patch 前自动创建 snapshot
// restore 按：本地 patch → artifact patch → git fallback 顺序尝试

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, rmSync } from "fs"
import { join } from "path"
import { execFileSync, execSync } from "child_process"
import type { SupabaseClient } from "@supabase/supabase-js"
import { gzipSync, gunzipSync } from "zlib"
import { workspaceRoot } from "./workspace"
import { redactSensitive, validatePath } from "./path-security"
import type { SnapshotRecord, RestoreResult } from "./types"

const SNAPSHOT_ROOT = "/tmp/mychat-agent-snapshots"

function snapshotDir(taskId: string, userId: string): string {
  return join(SNAPSHOT_ROOT, userId, taskId)
}

// ───────────── 工具类型 ─────────────

export type SnapshotResult =
  | { ok: true; snapshot: SnapshotRecord }
  | { ok: false; error: string }

// ───────────── 解析 diff 获取变更文件列表 ─────────────

function parseChangedFiles(diff: string): {
  changedFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  deletedFiles: string[]
} {
  const changedFiles: string[] = []
  const createdFiles: string[] = []
  const modifiedFiles: string[] = []
  const deletedFiles: string[] = []

  const lines = diff.split("\n")
  let currentPath = ""
  let mode = "modify"

  for (const line of lines) {
    const dm = line.match(/^diff --git a\/(.+?) b\/(.+?)$/)
    if (dm) {
      currentPath = dm[2]
      mode = dm[1] !== dm[2] ? "rename" : "modify"
      continue
    }
    if (line.startsWith("new file mode")) { mode = "add"; continue }
    if (line.startsWith("deleted file mode")) { mode = "delete"; continue }
    if (line === "--- /dev/null" && mode !== "delete") { mode = "add"; continue }
    if (line === "+++ /dev/null") { mode = "delete"; continue }

    // 在第一个 hunk 前确定
    if (line.startsWith("@@") && currentPath) {
      changedFiles.push(currentPath)
      if (mode === "add") createdFiles.push(currentPath)
      else if (mode === "delete") deletedFiles.push(currentPath)
      else modifiedFiles.push(currentPath)
      currentPath = ""
      mode = "modify"
    }
  }

  // 最后一个文件
  if (currentPath) {
    changedFiles.push(currentPath)
    if (mode === "add") createdFiles.push(currentPath)
    else if (mode === "delete") deletedFiles.push(currentPath)
    else modifiedFiles.push(currentPath)
  }

  return { changedFiles, createdFiles, modifiedFiles, deletedFiles }
}

// ───────────── 检测 workspace 是否存在变更 ─────────────

function hasWorkspaceChanges(root: string): boolean {
  try {
    const out = execSync("git status --porcelain", {
      cwd: root, timeout: 10_000, maxBuffer: 256 * 1024, encoding: "utf-8",
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}

// ───────────── 写入 agent_artifacts 持久化 snapshot ─────────────

async function persistSnapshotArtifact(
  supabase: SupabaseClient,
  snapshot: SnapshotRecord,
  patchContent: string,
): Promise<boolean> {
  try {
    // content: 保存摘要 + 打码 patch（不超过 50KB）
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

// ───────────── 从 agent_artifacts 读取 snapshot ─────────────

async function fetchSnapshotFromArtifact(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  snapshotId: string,
): Promise<{ ok: true; record: SnapshotRecord; patchContent: string } | { ok: false; error: string }> {
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
  } catch (err: any) {
    return { ok: false, error: `查询 artifact 失败：${err?.message ?? "未知错误"}` }
  }
}

// ───────────── 从 agent_artifacts 列出 snapshots ─────────────

async function listSnapshotsFromArtifacts(
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

    return (data ?? []).map((a: any) => {
      try {
        const p = JSON.parse(a.content ?? "{}")
        return {
          snapshotId: p.snapshotId ?? a.id,
          taskId,
          userId,
          reason: p.reason ?? "",
          changedFiles: p.changedFiles ?? [],
          createdFiles: p.createdFiles ?? [],
          modifiedFiles: p.modifiedFiles ?? [],
          deletedFiles: p.deletedFiles ?? [],
          createdAt: p.createdAt ?? a.created_at ?? "",
          diffSize: p.diffSize ?? 0,
          storage: "artifact",
          restorable: !!(a.meta?.restorable ?? true),
          workspaceId: a.meta?.workspaceId ?? null,
        } satisfies SnapshotRecord
      } catch {
        return null
      }
    }).filter(Boolean) as SnapshotRecord[]
  } catch {
    return []
  }
}

// ============================================================
//  PUBLIC API
// ============================================================

// ───────────── 创建 snapshot ─────────────

export async function createWorkspaceSnapshot(
  taskId: string,
  userId: string,
  reason: string,
  supabase?: SupabaseClient,
): Promise<SnapshotResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) {
    return { ok: false, error: `Workspace 不存在：${root}` }
  }

  // 干净状态同样必须可恢复；它是“第一次修改之前”的有效撤销点。
  if (!hasWorkspaceChanges(root)) {
    const snapshotId = crypto.randomUUID()
    const record: SnapshotRecord = {
      snapshotId, taskId, userId, reason,
      changedFiles: [], createdFiles: [], modifiedFiles: [], deletedFiles: [],
      createdAt: new Date().toISOString(), diffSize: 0,
      storage: "local", restorable: true, workspaceId: null,
    }
    let localOk = false
    try {
      const dir = snapshotDir(taskId, userId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${snapshotId}.patch`), "", "utf-8")
      writeFileSync(join(dir, `${snapshotId}.json`), JSON.stringify(record), "utf-8")
      localOk = true
    } catch {}
    const artifactOk = supabase ? await persistSnapshotArtifact(supabase, record, "") : false
    if (!localOk && !artifactOk) return { ok: false, error: "Snapshot 本地写入和持久化均失败" }
    record.storage = localOk && artifactOk ? "both" : localOk ? "local" : "artifact"
    return { ok: true, snapshot: record }
  }

  const snapshotId = crypto.randomUUID()
  const createdAt = new Date().toISOString()

  // 1) 生成 diff patch
  let diff = ""
  try {
    diff = execSync("git diff --no-color HEAD", {
      cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf-8",
    })

    // 追加未跟踪文件
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: root, timeout: 10_000, maxBuffer: 256 * 1024, encoding: "utf-8",
    }).trim()

    if (untracked) {
      for (const f of untracked.split("\n").filter(Boolean)) {
        try {
          const checked = validatePath(root, f)
          if (!checked.ok) continue
          const content = readFileSync(checked.absolute!, "utf-8")
          const lines = content.split("\n")
          diff += `\ndiff --git a/${f} b/${f}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}\n`
        } catch { /* skip binary */ }
      }
    }
  } catch {
    return { ok: false, error: "生成 diff 失败" }
  }

  if (!diff.trim()) {
    return {
      ok: true,
      snapshot: {
        snapshotId, taskId, userId, reason,
        changedFiles: [], createdFiles: [], modifiedFiles: [], deletedFiles: [],
        createdAt, diffSize: 0, storage: "local", restorable: false, workspaceId: null,
      },
    }
  }

  // 2) 解析变更文件
  const { changedFiles, createdFiles, modifiedFiles, deletedFiles } = parseChangedFiles(diff)

  // 3) 写本地 patch 文件
  let localOk = false
  try {
    const snapDir = snapshotDir(taskId, userId)
    mkdirSync(snapDir, { recursive: true })
    writeFileSync(join(snapDir, `${snapshotId}.patch`), diff, "utf-8")
    const meta = {
      snapshotId, taskId, userId, reason, createdAt,
      changedFiles, createdFiles, modifiedFiles, deletedFiles,
      diffSize: diff.length, fileCount: changedFiles.length,
    }
    writeFileSync(join(snapDir, `${snapshotId}.json`), JSON.stringify(meta), "utf-8")
    localOk = true
  } catch {
    // 本地写入失败不致命——artifact 仍然可用
  }

  // 4) 构建 snapshot record
  const record: SnapshotRecord = {
    snapshotId,
    taskId,
    userId,
    reason,
    changedFiles,
    createdFiles,
    modifiedFiles,
    deletedFiles,
    createdAt,
    diffSize: diff.length,
    storage: localOk ? "both" : "artifact",
    restorable: true,
    workspaceId: null, // 由调用方填充
  }

  // 5) 持久化到 agent_artifacts
  let artifactOk = false
  if (supabase) {
    artifactOk = await persistSnapshotArtifact(supabase, record, diff)
  }

  // 如果本地和 artifact 都失败，返回错误
  if (!localOk && !artifactOk) {
    return { ok: false, error: "Snapshot 本地写入和持久化均失败" }
  }

  record.storage = localOk && artifactOk ? "both" : localOk ? "local" : "artifact"

  return { ok: true, snapshot: record }
}

// ───────────── 恢复 snapshot（3-tier：local → artifact → git）─────────────

export async function restoreWorkspaceSnapshot(
  taskId: string,
  userId: string,
  snapshotId: string,
  supabase?: SupabaseClient,
): Promise<RestoreResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: `Workspace 不存在` }

  let source: RestoreResult["usedSource"] = "none"
  let patch: string | null = null
  let failedFiles = 0

  // ── Tier 1：本地 patch ──
  const snapDir = snapshotDir(taskId, userId)
  const localPatchPath = join(snapDir, `${snapshotId}.patch`)
  if (existsSync(localPatchPath)) {
    try {
      patch = readFileSync(localPatchPath, "utf-8")
      source = "local_patch"
    } catch { /* 读不到就继续 */ }
  }

  // ── Tier 2：artifact patch ──
  if (patch === null && supabase) {
    const fetched = await fetchSnapshotFromArtifact(supabase, userId, taskId, snapshotId)
    if (fetched.ok) {
      patch = fetched.patchContent
      source = "artifact_patch"
    }
  }

  // ── Tier 3：git fallback ──
  if (patch === null) {
    // 尝试读取本地 metadata 获取文件列表
    let fileList: string[] = []
    // 尝试从 artifact meta 获取文件列表
    if (supabase && !fileList.length) {
      const fetched = await fetchSnapshotFromArtifact(supabase, userId, taskId, snapshotId)
      if (fetched.ok) {
        fileList = fetched.record.changedFiles
      }
    }

    if (fileList.length) {
      let restored = 0
      for (const f of fileList) {
        try {
          execFileSync("git", ["checkout", "HEAD", "--", f], { cwd: root, timeout: 10_000, encoding: "utf-8" })
          restored++
        } catch {
          const checked = validatePath(root, f)
          if (checked.ok && existsSync(checked.absolute!)) {
            try { unlinkSync(checked.absolute!); restored++ } catch { failedFiles++ }
          }
        }
      }
      source = "git_fallback"
      return { ok: true, snapshotId, restoredFiles: restored, failedFiles, usedSource: source }
    }

    return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: `Snapshot 不存在（本地和 artifact 均未找到）：${snapshotId}` }
  }

  // ── 应用 patch 恢复 ──
  let restoredFiles = 0
  try {
    // Snapshot 保存的是“该时刻相对 HEAD 的完整状态”。恢复时先回到 HEAD，
    // 再正向应用 snapshot；反向应用会错误撤销 snapshot 之前的累计改动。
    execFileSync("git", ["reset", "--hard", "HEAD"], {
      cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf-8",
    })
    execFileSync("git", ["clean", "-fd"], {
      cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf-8",
    })

    if (patch.trim()) {
      try {
        const stat = execSync("git apply --stat", {
          cwd: root, timeout: 30_000, maxBuffer: 512 * 1024, encoding: "utf-8", input: patch,
        })
        restoredFiles = stat.trim().split("\n").filter(Boolean).length
      } catch {
        // stat 失败没关系，直接 apply
      }
      execSync("git apply", {
        cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf-8", input: patch,
      })
    }

    if (!restoredFiles) restoredFiles = (patch!.match(/^diff --git/gm) ?? []).length

    return { ok: true, snapshotId, restoredFiles, failedFiles, usedSource: source }
  } catch (err: any) {
    // git apply 失败，尝试逐个文件恢复
    const files = new Set<string>()
    const filePattern = /^[-]{3} a\/(.+?)$/gm
    let m
    while ((m = filePattern.exec(patch!)) !== null) {
      if (m[1] !== "/dev/null") files.add(m[1])
    }

    let manualRestored = 0
    for (const f of files) {
      try {
        execFileSync("git", ["checkout", "HEAD", "--", f], { cwd: root, timeout: 10_000, encoding: "utf-8" })
        manualRestored++
      } catch {
        const checked = validatePath(root, f)
        if (checked.ok && existsSync(checked.absolute!)) {
          try { unlinkSync(checked.absolute!); manualRestored++ } catch { failedFiles++ }
        }
      }
    }

    return {
      ok: manualRestored > 0,
      snapshotId,
      restoredFiles: manualRestored,
      failedFiles,
      usedSource: manualRestored > 0 ? "git_fallback" : "none",
      error: manualRestored === 0 ? `恢复失败：${err?.stderr ?? err?.message}` : undefined,
    }
  }
}

// ───────────── 列出 snapshots（合并 local + artifact）─────────────

export async function listWorkspaceSnapshots(
  taskId: string,
  userId: string,
  supabase?: SupabaseClient,
): Promise<{ ok: boolean; snapshots: SnapshotRecord[]; error?: string }> {
  const allSnapshots = new Map<string, SnapshotRecord>()

  // 1) 本地 snapshots
  const root = workspaceRoot(taskId, userId)
  if (existsSync(root)) {
    const snapDir = snapshotDir(taskId, userId)
    if (existsSync(snapDir)) {
      try {
        for (const entry of readdirSync(snapDir)) {
          if (entry.endsWith(".json")) {
            try {
              const meta = JSON.parse(readFileSync(join(snapDir, entry), "utf-8"))
              const patchPath = join(snapDir, entry.replace(/\.json$/, ".patch"))
              const patchExists = existsSync(patchPath)
              allSnapshots.set(meta.snapshotId || meta.id, {
                snapshotId: meta.snapshotId || meta.id,
                taskId, userId,
                reason: meta.reason ?? "",
                changedFiles: meta.changedFiles ?? [],
                createdFiles: meta.createdFiles ?? [],
                modifiedFiles: meta.modifiedFiles ?? [],
                deletedFiles: meta.deletedFiles ?? [],
                createdAt: meta.createdAt ?? "",
                diffSize: meta.diffSize ?? 0,
                storage: "local",
                restorable: patchExists,
                workspaceId: null,
              })
            } catch { /* skip corrupted */ }
          }
        }
      } catch { /* ignore */ }
    }
  }

  // 2) Artifact snapshots（补充本地没有的）
  if (supabase) {
    const artifacts = await listSnapshotsFromArtifacts(supabase, userId, taskId)
    for (const art of artifacts) {
      if (!allSnapshots.has(art.snapshotId)) {
        art.storage = "artifact"
        allSnapshots.set(art.snapshotId, art)
      } else {
        // 升级 storage 标记
        const existing = allSnapshots.get(art.snapshotId)!
        existing.storage = "both"
      }
    }
  }

  const snapshots = [...allSnapshots.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return { ok: true, snapshots }
}

// ───────────── 恢复最后一个 snapshot ─────────────

export async function revertLastWorkspaceChange(
  taskId: string,
  userId: string,
  supabase?: SupabaseClient,
): Promise<RestoreResult> {
  const list = await listWorkspaceSnapshots(taskId, userId, supabase)
  if (!list.ok) return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: list.error }
  if (!list.snapshots.length) return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: "没有可用的 snapshot" }

  const last = list.snapshots[0]
  if (!last.restorable) return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: "最近一次 snapshot 不可恢复" }

  return restoreWorkspaceSnapshot(taskId, userId, last.snapshotId, supabase)
}

// ───────────── Workspace 清理 ─────────────

export function cleanupWorkspace(
  taskId: string,
  userId: string,
): { ok: boolean; error?: string } {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: true } // nothing to clean

  try {
    rmSync(root, { recursive: true, force: true })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: `清理 workspace 失败：${err?.message ?? "未知错误"}` }
  }
}
