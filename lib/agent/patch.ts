// apply_patch：统一 diff 的 dry-run 和 apply，基于 git apply
// 所有 patch 操作在 workspace 内执行，经过安全校验

import { existsSync } from "fs"
import { execSync } from "child_process"
import type { SupabaseClient } from "@/lib/supabase/types"
import { workspaceRoot, getWorkspaceDiff } from "./workspace"
import { createWorkspaceSnapshot } from "./snapshot"
import { validatePath, redactSensitive } from "./path-security"
import { errorMessage, recordText } from '@/lib/unknown-value'

// ───────────── 类型 ─────────────

type PatchFile = {
  path: string
  oldPath?: string  // rename/copy from
  mode: "add" | "modify" | "delete" | "rename" | "unknown"
}

export type PatchResult = {
  ok: true
  changedFiles: string[]
  dryRun: boolean
  diffSummary: string
} | {
  ok: false
  error: string
  dryRun: boolean
}

// ───────────── 解析 patch 中的文件列表 ─────────────

function parsePatchFiles(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  const lines = patch.split("\n")

  let currentPath = ""
  let currentOldPath = ""
  let mode: PatchFile["mode"] = "unknown"

  for (const line of lines) {
    // diff --git a/file b/file
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/)
    if (diffMatch) {
      // 保存上一个
      if (currentPath) files.push({ path: currentPath, oldPath: currentOldPath || undefined, mode })
      currentPath = diffMatch[2]
      currentOldPath = diffMatch[1] !== diffMatch[2] ? diffMatch[1] : ""
      mode = "modify"
      continue
    }

    // new file mode → 新增
    if (line.startsWith("new file mode")) {
      mode = "add"
      continue
    }

    // deleted file mode → 删除
    if (line.startsWith("deleted file mode")) {
      mode = "delete"
      continue
    }

    // rename from / rename to
    const renameFrom = line.match(/^rename from (.+)$/)
    if (renameFrom) {
      currentOldPath = renameFrom[1]
      mode = "rename"
      continue
    }
    const renameTo = line.match(/^rename to (.+)$/)
    if (renameTo) {
      currentPath = renameTo[1]
      continue
    }

    // --- a/file → 源是 /dev/null = 新增
    if (line === "--- /dev/null" && mode !== "delete") {
      mode = "add"
      continue
    }

    // +++ b/file → 目标是 /dev/null = 删除
    if (line === "+++ /dev/null") {
      mode = "delete"
      continue
    }
  }

  // 最后一个
  if (currentPath) files.push({ path: currentPath, oldPath: currentOldPath || undefined, mode })

  return files
}

// ───────────── 安全校验 patch ─────────────

function validatePatchSafety(
  taskId: string,
  userId: string,
  patch: string,
  opts: { maxFiles?: number } = {},
): { ok: true; files: PatchFile[] } | { ok: false; error: string } {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: `Workspace 不存在` }

  const maxFiles = opts.maxFiles ?? 20

  // 1) 解析 patch 中涉及的文件
  const files = parsePatchFiles(patch)
  if (!files.length) return { ok: false, error: "Patch 中没有识别到任何文件变更" }

  // 2) 数量阈值
  if (files.length > maxFiles) {
    return { ok: false, error: `Patch 涉及 ${files.length} 个文件，超过上限 ${maxFiles} 个` }
  }

  // 3) 每个文件都要通过 path-security
  for (const f of files) {
    const chk = validatePath(root, f.path)
    if (!chk.ok) return { ok: false, error: `路径校验失败（${f.path}）：${chk.error}` }
    if (f.oldPath) {
      const oldChk = validatePath(root, f.oldPath)
      if (!oldChk.ok) return { ok: false, error: `路径校验失败（${f.oldPath}）：${oldChk.error}` }
    }
  }

  // 4) 禁止删除大量文件
  const deletes = files.filter(f => f.mode === "delete")
  if (deletes.length > 5) {
    return { ok: false, error: `Patch 包含 ${deletes.length} 个文件删除，超过上限 5 个：${deletes.map(d => d.path).join("、")}` }
  }

  return { ok: true, files }
}

// ───────────── Dry-run ─────────────

export function dryRunWorkspacePatch(
  taskId: string,
  userId: string,
  patch: string,
): PatchResult {
  // 先安全检查
  const safety = validatePatchSafety(taskId, userId, patch)
  if (!safety.ok) return { ok: false, error: safety.error, dryRun: true }

  const root = workspaceRoot(taskId, userId)

  try {
    // git apply --check：dry-run，不做任何修改
    execSync("git apply --check", {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
      input: patch,
    })

    // 生成 diff 预览
    const fileList = safety.files.map(f => `  ${f.mode === "add" ? "A" : f.mode === "delete" ? "D" : "M"} ${f.path}`).join("\n")
    return {
      ok: true,
      changedFiles: safety.files.map(f => f.path),
      dryRun: true,
      diffSummary: `## Dry-run 成功\n\n${safety.files.length} 个文件将被修改：\n\n${fileList}\n\n\`\`\`diff\n${redactSensitive(patch).slice(0, 3000)}\n\`\`\``,
    }
  } catch (error) {
    const stderr = recordText(error, 'stderr')
    return {
      ok: false,
      error: `Dry-run 失败：${stderr || errorMessage(error)}`,
      dryRun: true,
    }
  }
}

// ───────────── 实际 apply ─────────────

export async function applyWorkspacePatch(
  taskId: string,
  userId: string,
  patch: string,
  opts: { skipSnapshot?: boolean; supabase?: SupabaseClient } = {},
): Promise<PatchResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: `Workspace 不存在`, dryRun: false }

  // 1) 先 dry-run 检查
  const dry = dryRunWorkspacePatch(taskId, userId, patch)
  if (!dry.ok) return { ...dry, dryRun: false }

  // 2) 自动 snapshot
  if (!opts.skipSnapshot) {
    const files = dry.changedFiles.join(", ")
    const snap = await createWorkspaceSnapshot(taskId, userId, `auto: before apply_patch (${files})`, opts.supabase)
    if (!snap.ok) return { ok: false, error: `Snapshot 失败，拒绝 apply patch：${snap.error}`, dryRun: false }
  }

  // 3) 实际 apply
  try {
    execSync("git apply", {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
      input: patch,
    })
  } catch (error) {
    const stderr = recordText(error, 'stderr')
    return {
      ok: false,
      error: `Apply 失败：${stderr || errorMessage(error)}`,
      dryRun: false,
    }
  }

  // 4) 返回 diff summary
  const diff = getWorkspaceDiff(taskId, userId)
  return {
    ok: true,
    changedFiles: dry.changedFiles,
    dryRun: false,
    diffSummary: redactSensitive(diff).slice(0, 10000) || "Patch 已应用（无 diff 输出）",
  }
}
