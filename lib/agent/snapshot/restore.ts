import { execFileSync, execSync } from "child_process"
import { existsSync, readFileSync, unlinkSync } from "fs"
import { join } from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { validatePath } from "../path-security"
import type { RestoreResult } from "../types"
import { workspaceRoot } from "../workspace-paths"
import { fetchSnapshotFromArtifact } from "./artifact"
import { snapshotDir } from "./paths"

function restoreFilesFromHead(root: string, files: Iterable<string>): { restored: number; failed: number } {
  let restored = 0
  let failed = 0
  for (const file of files) {
    try {
      execFileSync("git", ["checkout", "HEAD", "--", file], {
        cwd: root,
        timeout: 10_000,
        encoding: "utf-8",
      })
      restored++
    } catch {
      const checked = validatePath(root, file)
      if (checked.ok && existsSync(checked.absolute!)) {
        try {
          unlinkSync(checked.absolute!)
          restored++
        } catch {
          failed++
        }
      }
    }
  }
  return { restored, failed }
}

function patchFiles(patch: string): Set<string> {
  const files = new Set<string>()
  const filePattern = /^[-]{3} a\/(.+?)$/gm
  let match: RegExpExecArray | null
  while ((match = filePattern.exec(patch)) !== null) {
    if (match[1] !== "/dev/null") files.add(match[1])
  }
  return files
}

export async function restoreWorkspaceSnapshot(
  taskId: string,
  userId: string,
  snapshotId: string,
  supabase?: SupabaseClient,
): Promise<RestoreResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) {
    return { ok: false, restoredFiles: 0, failedFiles: 0, usedSource: "none", error: "Workspace 不存在" }
  }

  let source: RestoreResult["usedSource"] = "none"
  let patch: string | null = null

  const localPatchPath = join(snapshotDir(taskId, userId), `${snapshotId}.patch`)
  if (existsSync(localPatchPath)) {
    try {
      patch = readFileSync(localPatchPath, "utf-8")
      source = "local_patch"
    } catch {
      // Continue to artifact recovery.
    }
  }

  if (patch === null && supabase) {
    const fetched = await fetchSnapshotFromArtifact(supabase, userId, taskId, snapshotId)
    if (fetched.ok) {
      patch = fetched.patchContent
      source = "artifact_patch"
    }
  }

  if (patch === null) {
    let fileList: string[] = []
    if (supabase) {
      const fetched = await fetchSnapshotFromArtifact(supabase, userId, taskId, snapshotId)
      if (fetched.ok) fileList = fetched.record.changedFiles
    }

    if (fileList.length) {
      const result = restoreFilesFromHead(root, fileList)
      return {
        ok: true,
        snapshotId,
        restoredFiles: result.restored,
        failedFiles: result.failed,
        usedSource: "git_fallback",
      }
    }

    return {
      ok: false,
      restoredFiles: 0,
      failedFiles: 0,
      usedSource: "none",
      error: `Snapshot 不存在（本地和 artifact 均未找到）：${snapshotId}`,
    }
  }

  let restoredFiles = 0
  try {
    execFileSync("git", ["reset", "--hard", "HEAD"], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
    })
    execFileSync("git", ["clean", "-fd"], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
    })

    if (patch.trim()) {
      try {
        const stat = execSync("git apply --stat", {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 512 * 1024,
          encoding: "utf-8",
          input: patch,
        })
        restoredFiles = stat.trim().split("\n").filter(Boolean).length
      } catch {
        // Applying the patch still provides the authoritative result.
      }
      execSync("git apply", {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf-8",
        input: patch,
      })
    }

    if (!restoredFiles) restoredFiles = (patch.match(/^diff --git/gm) ?? []).length
    return { ok: true, snapshotId, restoredFiles, failedFiles: 0, usedSource: source }
  } catch (error: any) {
    const result = restoreFilesFromHead(root, patchFiles(patch))
    return {
      ok: result.restored > 0,
      snapshotId,
      restoredFiles: result.restored,
      failedFiles: result.failed,
      usedSource: result.restored > 0 ? "git_fallback" : "none",
      error: result.restored === 0 ? `恢复失败：${error?.stderr ?? error?.message}` : undefined,
    }
  }
}
