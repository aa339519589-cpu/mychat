// Workspace 文件操作：读、写、编辑（old_string 替换）、删除、列表、diff
// 所有操作经过 path-security 校验，修改前自动 snapshot

import {
  readFileSync, writeFileSync, unlinkSync, existsSync, statSync,
  readdirSync, mkdirSync,
} from "fs"
import { join, dirname, relative } from "path"
import { execSync } from "child_process"
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
  return join(WORKSPACE_ROOT, userId, taskId)
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

// ───────────── 批量删除（带安全阈值）─────────────

import { checkDeleteThreshold, validateMultiplePaths } from "./path-security"

export async function deleteWorkspaceFiles(
  taskId: string,
  userId: string,
  rawPaths: string[],
  supabase?: SupabaseClient,
): Promise<WorkspaceResult<{ deleted: string[]; errors: string[]; diff: string }>> {
  if (!rawPaths.length) return { ok: false, error: "没有要删除的文件" }

  const root = workspaceRoot(taskId, userId)

  // 安全检查
  const threshold = checkDeleteThreshold(rawPaths.length, rawPaths)
  if (!threshold.ok) {
    return { ok: false, error: threshold.reason ?? "删除文件过多" }
  }

  const multi = validateMultiplePaths(root, rawPaths)
  if (!multi.ok) return { ok: false, error: multi.error! }

  // 自动 snapshot
  const snap = await createWorkspaceSnapshot(taskId, userId, `auto: before delete ${rawPaths.length} files`, supabase)
  if (!snap.ok) return { ok: false, error: `Snapshot 失败，拒绝删除：${snap.error}` }

  const deleted: string[] = []
  const errors: string[] = []

  for (const chk of multi.checks) {
    try {
      if (existsSync(chk.absolute!)) {
        unlinkSync(chk.absolute!)
        deleted.push(chk.normalized!)
      } else {
        errors.push(`${chk.normalized}: 文件不存在`)
      }
    } catch (err: any) {
      errors.push(`${chk.normalized}: ${err?.message}`)
    }
  }

  const diff = getWorkspaceDiff(taskId, userId)
  return {
    ok: true,
    data: {
      deleted,
      errors,
      diff: typeof diff === "string" ? redactSensitive(diff) : "",
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
  const base = subPath ? join(root, subPath) : root

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
    const out = execSync("git diff --no-color", {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf-8",
    })
    return out
  } catch {
    return ""
  }
}

// ───────────── 获取单个文件 diff ─────────────

export function getFileDiff(workspacePath: string, relPath: string): string {
  const abs = join(workspacePath, relPath)
  try {
    // 判断是否被 git 跟踪
    let tracked = false
    try {
      execSync(`git ls-files --error-unmatch -- "${relPath}"`, {
        cwd: workspacePath, timeout: 5000, encoding: "utf-8", stdio: "pipe",
      })
      tracked = true
    } catch { /* untracked */ }

    if (tracked) {
      const out = execSync(`git diff --no-color -- "${relPath}"`, {
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
    const out = execSync("git status --porcelain", {
      cwd: root,
      timeout: 10_000,
      maxBuffer: 512 * 1024,
      encoding: "utf-8",
    })

    const lines = out.trim().split("\n").filter(Boolean)
    const files: { path: string; status: string }[] = []
    let added = 0, modified = 0, deleted = 0

    for (const line of lines) {
      const statusCode = line.slice(0, 2).trim()
      const filePath = line.slice(3).trim()
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

// ───────────── 恢复单个文件到 git HEAD ─────────────

export function revertWorkspaceFile(
  taskId: string,
  userId: string,
  rawPath: string,
): WorkspaceResult<{ path: string }> {
  const root = workspaceRoot(taskId, userId)
  const chk = validatePath(root, rawPath)
  if (!chk.ok) return { ok: false, error: chk.error! }

  const abs = chk.absolute!
  if (!existsSync(abs)) return { ok: false, error: `文件不存在：${chk.normalized}` }

  try {
    execSync(`git checkout -- "${chk.normalized}"`, {
      cwd: root,
      timeout: 10_000,
      encoding: "utf-8",
    })
  } catch (err: any) {
    // 如果文件未被 git 跟踪，直接删除
    if (err?.stderr?.includes("did not match any file")) {
      try { unlinkSync(abs) } catch { /* ignore */ }
    } else {
      return { ok: false, error: `恢复失败：${err?.stderr || err?.message}` }
    }
  }

  return { ok: true, data: { path: chk.normalized! } }
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
  return {
    taskId, userId, repo,
    baseBranch: (result as any)?.branch ?? "main",
    agentBranch: (result as any)?.agentBranch ?? `agent/${taskId.slice(0, 8)}`,
    path: workspacePath(userId, taskId),
    commit: (result as any)?.commitSha ?? null,
    status: "ready",
  }
}

// compat: re-export for remote consumers
export { getGitInfo } from "./git-workspace"

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB
