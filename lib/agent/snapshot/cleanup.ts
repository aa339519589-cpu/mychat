import { existsSync, rmSync } from "fs"
import { workspaceRoot } from "../workspace-paths"

export function cleanupWorkspace(taskId: string, userId: string): { ok: boolean; error?: string } {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: true }

  try {
    rmSync(root, { recursive: true, force: true })
    return { ok: true }
  } catch (error: any) {
    return { ok: false, error: `清理 workspace 失败：${error?.message ?? "未知错误"}` }
  }
}
