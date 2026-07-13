import { join } from "path"

/** Runtime-only tenant root under /tmp; never used as a build input. */
export const WORKSPACE_ROOT = "/tmp/mychat-agent-workspaces"

export function workspaceRoot(taskId: string, userId: string): string {
  return join(WORKSPACE_ROOT, userId, taskId)
}

/** Compatibility order used by recovery and route modules. */
export function workspacePath(userId: string, taskId: string): string {
  return workspaceRoot(taskId, userId)
}
