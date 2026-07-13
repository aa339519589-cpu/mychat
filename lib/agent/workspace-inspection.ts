import { existsSync, readFileSync, readdirSync } from "fs"
import { execFileSync } from "child_process"
import { join, relative } from "path"

import { fileTooBig, isBinaryFile, redactSensitive, validatePath } from "./path-security"
import { workspaceRoot } from "./workspace-paths"
import type { WorkspaceResult } from "./workspace-types"
import { errorMessage } from '@/lib/unknown-value'

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
  } catch (error) {
    return { ok: false, error: `列出文件失败：${errorMessage(error)}` }
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

export function getFileDiff(workspacePath: string, relPath: string): string {
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
