import { join } from "path"

const SNAPSHOT_ROOT = "/tmp/mychat-agent-snapshots"

export function snapshotDir(taskId: string, userId: string): string {
  return join(SNAPSHOT_ROOT, userId, taskId)
}
