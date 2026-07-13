// Snapshot / Rollback public API. Implementations live in focused snapshot modules.

export { cleanupWorkspace } from "./snapshot/cleanup"
export { createWorkspaceSnapshot, type SnapshotResult } from "./snapshot/create"
export { listWorkspaceSnapshots, revertLastWorkspaceChange } from "./snapshot/catalog"
export { restoreWorkspaceSnapshot } from "./snapshot/restore"
