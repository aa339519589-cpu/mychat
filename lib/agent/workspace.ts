// Workspace 文件操作：读、写、编辑（old_string 替换）、删除、列表、diff
// 所有操作经过 path-security 校验，修改前自动 snapshot

import {
  readFileSync, writeFileSync, unlinkSync, existsSync,
  mkdirSync,
} from "fs"
import { dirname } from "path"
import type { SupabaseClient } from "@/lib/supabase/types"
import { validatePath, isBinaryFile, fileTooBig, redactSensitive } from "./path-security"
import { createWorkspaceSnapshot } from "./snapshot"
import { workspacePath, workspaceRoot } from "./workspace-paths"
import type { WorkspaceResult } from "./workspace-types"
import { getChangedFiles, getFileDiff } from "./workspace-inspection"
import { errorMessage } from '@/lib/unknown-value'

export { WORKSPACE_ROOT, workspacePath, workspaceRoot } from "./workspace-paths"
export type { WorkspaceResult } from "./workspace-types"
export {
  getChangedFiles,
  getWorkspaceDiff,
  listWorkspaceFiles,
  searchWorkspaceFiles,
} from "./workspace-inspection"

// ───────────── 结果类型 ─────────────

// ───────────── 内部：解析 workspace 路径 ─────────────

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
  } catch (error) {
    return { ok: false, error: `读取失败：${errorMessage(error)}` }
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
  } catch (error) {
    return { ok: false, error: `写入失败：${errorMessage(error)}` }
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
  } catch (error) {
    return { ok: false, error: `读取失败：${errorMessage(error)}` }
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
  } catch (error) {
    return { ok: false, error: `写入失败：${errorMessage(error)}` }
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
  } catch (error) {
    return { ok: false, error: `删除失败：${errorMessage(error)}` }
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

// ───────────── 检查 workspace 是否存在且 ready ─────────────

// compat: remote's createWorkspaceForTask — delegates to git-workspace.ts cloneWorkspace
export async function createWorkspaceForTask(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  token: string,
  repo: string,
  _goal?: string,
  baseBranch = "main",
  restoreCheckpoint = true,
): Promise<{
  taskId: string
  userId: string
  repo: string
  baseBranch: string
  agentBranch: string
  path: string
  commit: string | null
  status: 'ready'
} | { error: string }> {
  const { cloneWorkspace: cloneWs } = await import("./git-workspace")
  const result = await cloneWs(userId, taskId, repo, token, _goal ?? "task", baseBranch)
  if ("error" in result) return result
  const wsPath = workspacePath(userId, taskId)
  const wsInfo = {
    taskId, userId, repo,
    baseBranch: result.branch,
    agentBranch: result.agentBranch,
    path: wsPath,
    commit: null,
    status: "ready" as const,
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
        commit_sha: null,
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
        path: wsPath,
      })
    }
    // 更新状态为 ready
    const { updateWorkspaceStatus } = await import("./data")
    await updateWorkspaceStatus(supabase, userId, taskId, "ready", {
      path: wsPath,
    })
    await supabase.from("agent_tasks").update({
      repo,
      branch: wsInfo.baseBranch,
      updated_at: new Date().toISOString(),
    }).eq("id", taskId).eq("user_id", userId)
  } catch (error) {
    console.error('[workspace] DB persist failed (non-fatal)', errorMessage(error))
  }

  const currentChanges = getChangedFiles(taskId, userId)
  if (restoreCheckpoint && (!currentChanges.ok || currentChanges.data.files.length === 0)) {
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
