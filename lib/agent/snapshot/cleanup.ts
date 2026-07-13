import { existsSync, rmSync } from "fs"
import { workspaceRoot } from "../workspace-paths"
import { errorMessage } from '@/lib/unknown-value'

export function cleanupWorkspace(taskId: string, userId: string): { ok: boolean; error?: string } {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: true }

  try {
    rmSync(root, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: `清理 workspace 失败：${errorMessage(error)}` }
  }
}
