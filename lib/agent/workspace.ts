// Workspace 管理器：创建、查询、文件操作、清理。
// 组合 git-workspace + path-security，提供统一接口给 API route 使用。

import { readFile, writeFile, unlink, readdir, stat } from "fs/promises"
import type { Dirent } from "fs"
import { existsSync } from "fs"
import { join, relative } from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  cloneWorkspace, cleanupWorkspace as gitCleanup,
  getGitInfo, getWorkspaceDiff, ROOT, agentBranch,
} from "./git-workspace"
import { safeResolve, isExcluded, isTextFile, MAX_FILE_SIZE_BYTES } from "./path-security"
import { addWorkspace, updateTaskStatus } from "./data"
import { log } from "@/lib/logger"

// ── 类型 ──

export type FileEntry = {
  path: string
  type: "file" | "dir"
  size: number
  modified: string | null
}

export type WorkspaceInfo = {
  taskId: string
  userId: string
  repo: string
  baseBranch: string
  agentBranch: string
  path: string
  commit?: string
  status: string
  fileCount?: number
}

// ── 列出文件 ──

async function listDir(base: string, dir = ""): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  const fullDir = join(base, dir)
  let items: Dirent[]
  try {
    items = await readdir(fullDir, { withFileTypes: true }) as unknown as Dirent[]
  } catch {
    return entries
  }

  for (const item of items) {
    const rel = dir ? `${dir}/${item.name}` : item.name
    if (isExcluded(rel)) continue

    if (item.isDirectory()) {
      entries.push({ path: rel + "/", type: "dir", size: 0, modified: null })
      // 递归但限制深度（防超大文件树）
      if (rel.split("/").length < 6) {
        const sub = await listDir(base, rel)
        entries.push(...sub)
      }
    } else if (item.isFile()) {
      try {
        const s = await stat(join(base, rel))
        if (s.size > MAX_FILE_SIZE_BYTES) continue
        entries.push({
          path: rel,
          type: "file",
          size: s.size,
          modified: s.mtime.toISOString(),
        })
      } catch {
        entries.push({ path: rel, type: "file", size: 0, modified: null })
      }
    }
  }
  return entries
}

// ── 创建 / 确保 workspace ──

export async function createWorkspaceForTask(
  supabase: SupabaseClient, userId: string, taskId: string,
  token: string, repo: string, goal: string, baseBranch = "main",
): Promise<WorkspaceInfo | { error: string }> {
  // Clone
  const result = await cloneWorkspace(userId, taskId, repo, token, goal, baseBranch)
  if ("error" in result) return result

  // Git info
  let commit: string | undefined
  const info = await getGitInfo(result.path)
  if (!("error" in info)) commit = info.commit

  // 写入 agent_workspaces（upsert）
  if (supabase) {
    const { data: existing } = await supabase
      .from("agent_workspaces")
      .select("id").eq("task_id", taskId).limit(1)

    if (!existing?.length) {
      await addWorkspace(supabase, userId, {
        taskId,
        repo,
        branch: result.agentBranch,
        commitSha: commit,
        path: result.path,
      }).catch(() => {})
    }
  }

  return {
    taskId, userId, repo,
    baseBranch: result.branch,
    agentBranch: result.agentBranch,
    path: result.path,
    commit,
    status: "ready",
  }
}

// ── 获取 workspace 信息 ──

export function getWorkspaceForTask(userId: string, taskId: string): WorkspaceInfo | null {
  const base = join(ROOT, userId, taskId)
  if (!existsSync(join(base, ".git"))) return null
  return { taskId, userId, repo: "", baseBranch: "", agentBranch: "", path: base, status: "ready" }
}

// ── workspace 路径 ──

export function workspacePath(userId: string, taskId: string): string {
  return join(ROOT, userId, taskId)
}

// ── 文件操作 ──

export async function listWorkspaceFiles(userId: string, taskId: string): Promise<FileEntry[] | { error: string }> {
  const base = workspacePath(userId, taskId)
  if (!existsSync(base)) return { error: "Workspace 不存在" }
  return listDir(base)
}

export async function readWorkspaceFile(
  userId: string, taskId: string, filePath: string,
): Promise<{ content: string; path: string } | { error: string }> {
  const base = workspacePath(userId, taskId)
  if (!existsSync(base)) return { error: "Workspace 不存在" }

  const resolved = safeResolve(base, filePath)
  if (!resolved) return { error: "路径不合法" }

  if (!isTextFile(filePath)) return { error: "不支持读取该文件类型" }

  try {
    const s = await stat(resolved)
    if (s.size > MAX_FILE_SIZE_BYTES) return { error: "文件过大" }
    const content = await readFile(resolved, "utf-8")
    return { content, path: filePath }
  } catch (e: any) {
    return { error: e?.message ?? "读取失败" }
  }
}

export async function writeWorkspaceFile(
  userId: string, taskId: string, filePath: string, content: string,
): Promise<{ ok: true; path: string } | { error: string }> {
  const base = workspacePath(userId, taskId)
  if (!existsSync(base)) return { error: "Workspace 不存在" }

  const resolved = safeResolve(base, filePath)
  if (!resolved) return { error: "路径不合法" }

  try {
    await writeFile(resolved, content, "utf-8")
    return { ok: true, path: filePath }
  } catch (e: any) {
    return { error: e?.message ?? "写入失败" }
  }
}

export async function deleteWorkspaceFile(
  userId: string, taskId: string, filePath: string,
): Promise<{ ok: true; path: string } | { error: string }> {
  const base = workspacePath(userId, taskId)
  if (!existsSync(base)) return { error: "Workspace 不存在" }

  const resolved = safeResolve(base, filePath)
  if (!resolved) return { error: "路径不合法" }

  try {
    await unlink(resolved)
    return { ok: true, path: filePath }
  } catch (e: any) {
    return { error: e?.message ?? "删除失败" }
  }
}

export async function cleanupWorkspace(userId: string, taskId: string): Promise<boolean> {
  return gitCleanup(userId, taskId)
}

// ── 导出给 API 用 ──

export { getWorkspaceDiff, agentBranch, cloneWorkspace }
export { safeResolve, isExcluded, isTextFile } from "./path-security"
