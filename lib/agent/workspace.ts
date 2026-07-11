// Workspace 文件操作：读、写、编辑（old_string 替换）、删除、列表、diff
// 所有操作经过 path-security 校验，修改前自动 snapshot

import {
  readFileSync, writeFileSync, unlinkSync, existsSync,
  readdirSync, mkdirSync,
} from "fs"
import { join, dirname, relative } from "path"
import { execFileSync } from "child_process"
import type { SupabaseClient } from "@supabase/supabase-js"
import { validatePath, isBinaryFile, fileTooBig, redactSensitive } from "./path-security"
import { createWorkspaceSnapshot } from "./snapshot"

// ───────────── 结果类型 ─────────────

export type WorkspaceResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// ───────────── 内部：解析 workspace 路径 ─────────────

// workspace 根目录约定：统一使用 /tmp/mychat-agent-workspaces/{userId}/{taskId}
// 与 lib/agent/git-workspace.ts 的 clone 路径保持一致
export const WORKSPACE_ROOT = "/tmp/mychat-agent-workspaces"

function workspaceRoot(taskId: string, userId: string): string {
  // Runtime-only tenant path under /tmp; it is never a build input.
  return join(WORKSPACE_ROOT, /* turbopackIgnore: true */ userId, taskId)
}

// ───────────── 读取文件 ─────────────

export function readWorkspaceFile(
  taskId: string,
  userId: string,
  rawPath: string,
): WorkspaceResult<{ path: string; content: string; size: number }> {
  const root = workspaceRoot(taskId, userId)
  const chk = validatePath(root, rawPath)
  if (!chk.ok) return { ok: false, error: chk.error! }

  const abs = chk.absolute!
  if (!existsSync(abs)) return { ok: false, error: `文件不存在：${chk.normalized}` }
  if (isBinaryFile(abs)) return { ok: false, error: `无法以文本方式读取二进制文件：${chk.normalized}` }
  if (fileTooBig(abs)) return { ok: false, error: `文件过大（>2MB）：${chk.normalized}` }

  try {
    const content = readFileSync(abs, "utf-8")
    return { ok: true, data: { path: chk.normalized!, content, size: content.length } }
  } catch (err: any) {
    return { ok: false, error: `读取失败：${err?.message ?? "未知错误"}` }
  }
}

// ───────────── 写入文件 ─────────────

export async function writeWorkspaceFile(
  taskId: string,
  userId: string,
  rawPath: string,
  content: string,
  supabase?: SupabaseClient,
): Promise<WorkspaceResult<{ path: string; created: boolean; diff: string; snapshotId?: string }>> {
  const root = workspaceRoot(taskId, userId)
  const chk = validatePath(root, rawPath)
  if (!chk.ok) return { ok: false, error: chk.error! }

  if (typeof content !== "string") return { ok: false, error: "内容必须是字符串" }
  if (content.length > MAX_FILE_SIZE) return { ok: false, error: `文件内容过大（>${MAX_FILE_SIZE / 1024 / 1024}MB）` }

  // 检测是否为二进制内容（简单 heuristic）
  if (content.includes("\0")) return { ok: false, error: "内容包含空字节，疑似二进制，拒绝文本写入" }

  const abs = chk.absolute!
  const existed = existsSync(abs)

  // 自动 snapshot（async）
  const snap = await createWorkspaceSnapshot(taskId, userId, `auto: before write ${chk.normalized}`, supabase)
  if (!snap.ok) return { ok: false, error: `Snapshot 失败，拒绝写入：${snap.error}` }

  try {
    // 确保父目录存在
    const dir = dirname(abs)
    mkdirSync(dir, { recursive: true })

    writeFileSync(abs, content, "utf-8")
  } catch (err: any) {
    return { ok: false, error: `写入失败：${err?.message ?? "未知错误"}` }
  }

  // 获取 diff
  const diff = getFileDiff(root, chk.normalized!)

  return {
    ok: true,
    data: {
      path: chk.normalized!,
      created: !existed,
      diff: redactSensitive(diff),
      snapshotId: snap.ok ? snap.snapshot.snapshotId || undefined : undefined,
    },
  }
}

// ───────────── 编辑文件（old_string 精确替换）─────────────

export async function editWorkspaceFile(
  taskId: string,
  userId: string,
  rawPath: string,
  oldString: string,
  newString: string,
  supabase?: SupabaseClient,
): Promise<WorkspaceResult<{ path: string; replaced: number; diff: string; snapshotId?: string }>> {
  const root = workspaceRoot(taskId, userId)
  const chk = validatePath(root, rawPath)
  if (!chk.ok) return { ok: false, error: chk.error! }

  if (!oldString) return { ok: false, error: "old_string 不能为空" }

  const abs = chk.absolute!
  if (!existsSync(abs)) return { ok: false, error: `文件不存在：${chk.normalized}` }
  if (isBinaryFile(abs)) return { ok: false, error: `无法编辑二进制文件：${chk.normalized}` }
  if (fileTooBig(abs)) return { ok: false, error: `文件过大（>2MB）：${chk.normalized}` }

  let content: string
  try {
    content = readFileSync(abs, "utf-8")
  } catch (err: any) {
    return { ok: false, error: `读取失败：${err?.message ?? "未知错误"}` }
  }

  // 查找 old_string
  const idx = content.indexOf(oldString)
  if (idx === -1) {
    return { ok: false, error: `在 ${chk.normalized} 中找不到指定的 old_string（区分大小写）。请用 read_file 确认准确内容后重试。` }
  }
  if (content.indexOf(oldString, idx + 1) !== -1) {
    return { ok: false, error: `在 ${chk.normalized} 中找到多处匹配，请提供更精确的上下文以区分。` }
  }

  // 自动 snapshot
  const snap = await createWorkspaceSnapshot(taskId, userId, `auto: before edit ${chk.normalized}`, supabase)
  if (!snap.ok) return { ok: false, error: `Snapshot 失败，拒绝编辑：${snap.error}` }

  const newContent = content.slice(0, idx) + newString + content.slice(idx + oldString.length)

  try {
    writeFileSync(abs, newContent, "utf-8")
  } catch (err: any) {
    return { ok: false, error: `写入失败：${err?.message ?? "未知错误"}` }
  }

  const diff = getFileDiff(root, chk.normalized!)

  return {
    ok: true,
    data: {
      path: chk.normalized!,
      replaced: 1,
      diff: redactSensitive(diff),
      snapshotId: snap.ok ? snap.snapshot.snapshotId || undefined : undefined,
    },
  }
}

// ───────────── 删除文件 ─────────────

export async function deleteWorkspaceFile(
  taskId: string,
  userId: string,
  rawPath: string,
  supabase?: SupabaseClient,
): Promise<WorkspaceResult<{ path: string; diff: string; snapshotId?: string }>> {
  const root = workspaceRoot(taskId, userId)
  const chk = validatePath(root, rawPath)
  if (!chk.ok) return { ok: false, error: chk.error! }

  const abs = chk.absolute!
  if (!existsSync(abs)) return { ok: false, error: `文件不存在：${chk.normalized}` }

  // 删前捕获内容生成 diff（删后 git diff 返回空）
  let oldContent = ""
  try { oldContent = readFileSync(abs, "utf-8") } catch {}
  const oldLines = oldContent.split("\n")
  const preDiff = oldContent
    ? `--- a/${chk.normalized}\n+++ /dev/null\n@@ -1,${oldLines.length} +0,0 @@\n${oldLines.map(l => `-${l}`).join("\n")}`
    : ""

  // 自动 snapshot
  const snap = await createWorkspaceSnapshot(taskId, userId, `auto: before delete ${chk.normalized}`, supabase)
  if (!snap.ok) return { ok: false, error: `Snapshot 失败，拒绝删除：${snap.error}` }

  try {
    unlinkSync(abs)
  } catch (err: any) {
    return { ok: false, error: `删除失败：${err?.message ?? "未知错误"}` }
  }

  return {
    ok: true,
    data: {
      path: chk.normalized!,
      diff: redactSensitive(preDiff),
      snapshotId: snap.ok ? snap.snapshot.snapshotId || undefined : undefined,
    },
  }
}

// ───────────── 列出 workspace 文件 ─────────────

export function listWorkspaceFiles(
  taskId: string,
  userId: string,
  subPath?: string,
  maxFiles = 400,
): WorkspaceResult<{ files: string[]; total: number; truncated: boolean }> {
  const root = workspaceRoot(taskId, userId)
  const checked = subPath ? validatePath(root, subPath) : null
  if (checked && !checked.ok) return { ok: false, error: checked.error! }
  const base = checked?.absolute ?? root

  if (!existsSync(base)) return { ok: false, error: `目录不存在：${subPath ?? "/"}` }

  const files: string[] = []
  try {
    walk(base, root, files, maxFiles)
  } catch (err: any) {
    return { ok: false, error: `列出文件失败：${err?.message}` }
  }

  return {
    ok: true,
    data: {
      files,
      total: files.length,
      truncated: files.length >= maxFiles,
    },
  }
}

// ───────────── 搜索 workspace 文本 ─────────────

export function searchWorkspaceFiles(
  taskId: string,
  userId: string,
  rawQuery: string,
  options: { path?: string; caseSensitive?: boolean; maxResults?: number } = {},
): WorkspaceResult<{ matches: string[]; searchedFiles: number; truncated: boolean }> {
  const query = rawQuery.trim()
  if (!query) return { ok: false, error: "搜索内容为空" }
  if (query.length > 200) return { ok: false, error: "搜索内容过长（最多 200 字符）" }

  const listed = listWorkspaceFiles(taskId, userId, options.path, 2000)
  if (!listed.ok) return listed

  const root = workspaceRoot(taskId, userId)
  const maxResults = Math.min(Math.max(options.maxResults ?? 100, 1), 200)
  const needle = options.caseSensitive ? query : query.toLowerCase()
  const matches: string[] = []
  let searchedFiles = 0

  for (const path of listed.data.files) {
    const checked = validatePath(root, path)
    if (!checked.ok || isBinaryFile(checked.absolute!) || fileTooBig(checked.absolute!, 512 * 1024)) continue

    let content = ""
    try { content = readFileSync(checked.absolute!, "utf-8") } catch { continue }
    searchedFiles++

    const lines = content.split("\n")
    for (let index = 0; index < lines.length; index++) {
      const haystack = options.caseSensitive ? lines[index] : lines[index].toLowerCase()
      if (!haystack.includes(needle)) continue
      matches.push(redactSensitive(`${path}:${index + 1}: ${lines[index].trim().slice(0, 300)}`))
      if (matches.length >= maxResults) {
        return { ok: true, data: { matches, searchedFiles, truncated: true } }
      }
    }
  }

  return { ok: true, data: { matches, searchedFiles, truncated: false } }
}

function walk(dir: string, root: string, out: string[], max: number) {
  if (out.length >= max) return
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (out.length >= max) return
    // 跳过被禁止的目录
    const rel = relative(root, join(dir, e.name))
    if (e.isDirectory()) {
      const skip = [".git", "node_modules", ".next", "dist", "build", ".turbo", "coverage", "__pycache__", ".cache", "vendor", "bower_components"]
      if (skip.includes(e.name)) continue
      walk(join(dir, e.name), root, out, max)
    } else if (e.isFile()) {
      // 跳过敏感文件
      if ([".env", ".env.local", ".env.production", ".env.development"].includes(e.name)) continue
      out.push(rel)
    }
  }
}

// ───────────── 获取 workspace 整体 diff（unified diff）─────────────

export function getWorkspaceDiff(taskId: string, userId: string): string {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return ""

  try {
    let out = execFileSync("git", ["diff", "--no-color"], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf-8",
    })

    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean)
    for (const path of untracked) {
      const checked = validatePath(root, path)
      if (checked.ok) out += `${out ? "\n" : ""}${getFileDiff(root, path)}`
      if (out.length >= 2 * 1024 * 1024) return out.slice(0, 2 * 1024 * 1024)
    }
    return out
  } catch {
    return ""
  }
}

// ───────────── 获取单个文件 diff ─────────────

function getFileDiff(workspacePath: string, relPath: string): string {
  const abs = join(workspacePath, relPath)
  try {
    // 判断是否被 git 跟踪
    let tracked = false
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
        cwd: workspacePath, timeout: 5000, encoding: "utf-8", stdio: "pipe",
      })
      tracked = true
    } catch { /* untracked */ }

    if (tracked) {
      const out = execFileSync("git", ["diff", "--no-color", "--", relPath], {
        cwd: workspacePath, timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf-8",
      })
      if (out.trim()) return out
    }

    // 新文件或 diff 为空：读出内容生成模拟 diff
    if (existsSync(abs)) {
      const content = readFileSync(abs, "utf-8")
      const lines = content.split("\n")
      return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`
    }
    return ""
  } catch {
    return ""
  }
}

// ───────────── 获取 workspace 变更文件列表 ─────────────

export function getChangedFiles(taskId: string, userId: string): WorkspaceResult<{
  files: { path: string; status: string }[]
  summary: { added: number; modified: number; deleted: number }
}> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: true, data: { files: [], summary: { added: 0, modified: 0, deleted: 0 } } }

  try {
    const out = execFileSync("git", ["status", "--porcelain", "-z"], {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      encoding: "utf-8",
    })

    const lines = out.split("\0").filter(line => line.length > 0)
    const files: { path: string; status: string }[] = []
    let added = 0, modified = 0, deleted = 0

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      const statusCode = line.slice(0, 2).trim()
      const filePath = line.slice(3)
      if (!filePath) continue

      let status = "unknown"
      if (statusCode === "??" || statusCode === "A") { status = "added"; added++ }
      else if (statusCode === "M") { status = "modified"; modified++ }
      else if (statusCode === "D") { status = "deleted"; deleted++ }
      else if (statusCode === "AM" || statusCode === "MM") { status = "modified"; modified++ }

      // 跳过禁止的文件
      if (
        filePath.startsWith(".git") ||
        filePath.includes("node_modules") ||
        filePath.includes(".next") ||
        [".env", ".env.local", ".env.production", ".env.development"].includes(filePath)
      ) continue

      files.push({ path: filePath, status })
      // porcelain -z 为 rename/copy 额外输出一个旧路径字段。
      if (statusCode.includes("R") || statusCode.includes("C")) index++
    }

    return {
      ok: true,
      data: {
        files,
        summary: { added, modified, deleted },
      },
    }
  } catch {
    return { ok: true, data: { files: [], summary: { added: 0, modified: 0, deleted: 0 } } }
  }
}

// ───────────── 检查 workspace 是否存在且 ready ─────────────

export { workspaceRoot }

// compat: remote's workspacePath(userId, taskId) → our workspaceRoot(taskId, userId)
export function workspacePath(userId: string, taskId: string): string {
  return workspaceRoot(taskId, userId)
}

// compat: remote's createWorkspaceForTask — delegates to git-workspace.ts cloneWorkspace
export async function createWorkspaceForTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  token: string,
  repo: string,
  _goal?: string,
  baseBranch = "main",
): Promise<any> {
  const { cloneWorkspace: cloneWs } = await import("./git-workspace")
  const result = await cloneWs(userId, taskId, repo, token, _goal ?? "task", baseBranch)
  if (typeof result === "object" && result !== null && "error" in result) {
    return { error: (result as any).error }
  }
  const wsPath = workspacePath(userId, taskId)
  const wsInfo = {
    taskId, userId, repo,
    baseBranch: (result as any)?.branch ?? "main",
    agentBranch: (result as any)?.agentBranch ?? `agent/${taskId.slice(0, 8)}`,
    path: wsPath,
    commit: (result as any)?.commitSha ?? null,
    status: "ready",
  }

  // 持久化到 agent_workspaces 表，确保后续 getTaskDetail 能查到
  try {
    const { data: existing } = await supabase
      .from("agent_workspaces")
      .select("id")
      .eq("task_id", taskId)
      .eq("user_id", userId)
      .limit(1)
    if (existing?.length) {
      await supabase.from("agent_workspaces").update({
        repo,
        branch: wsInfo.baseBranch,
        commit_sha: wsInfo.commit,
        path: wsPath,
        status: "ready",
        updated_at: new Date().toISOString(),
      }).eq("id", existing[0].id).eq("user_id", userId)
    } else {
      const { addWorkspace } = await import("./data")
      await addWorkspace(supabase, userId, {
        taskId,
        repo,
        branch: wsInfo.baseBranch,
        commitSha: wsInfo.commit,
        path: wsPath,
      })
    }
    // 更新状态为 ready
    const { updateWorkspaceStatus } = await import("./data")
    await updateWorkspaceStatus(supabase, userId, taskId, "ready", {
      path: wsPath,
      commitSha: wsInfo.commit,
    })
    await supabase.from("agent_tasks").update({
      repo,
      branch: wsInfo.baseBranch,
      updated_at: new Date().toISOString(),
    }).eq("id", taskId).eq("user_id", userId)
  } catch (err: any) {
    console.error('[workspace] DB persist failed (non-fatal)', err?.message)
  }

  const currentChanges = getChangedFiles(taskId, userId)
  if (!currentChanges.ok || currentChanges.data.files.length === 0) {
    const { restoreLatestWorkspaceCheckpoint } = await import("./checkpoint")
    const restored = await restoreLatestWorkspaceCheckpoint(supabase, userId, taskId)
    if (!restored.ok) return { error: `Workspace 检查点恢复失败：${restored.error}` }
    if (restored.restored) {
      const { updateWorkspaceStatus } = await import("./data")
      await updateWorkspaceStatus(supabase, userId, taskId, "dirty", { path: wsPath })
    }
  }

  return wsInfo
}

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB
