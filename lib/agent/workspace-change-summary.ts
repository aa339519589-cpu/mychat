import type { SnapshotEntry } from './snapshot/cas-types'

type ChangeStatus = 'added' | 'modified' | 'deleted'

const changeStatus: Record<SnapshotEntry['change'], ChangeStatus> = {
  created: 'added',
  modified: 'modified',
  deleted: 'deleted',
}

export const workspaceGitChangeStatus: Record<ChangeStatus, 'A' | 'M' | 'D'> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
}

// Consume entries only after readWorkspaceAuthorityView verifies ownership,
// the immutable manifest, and its binding to the database's current head.
export function summarizeWorkspaceChanges(entries: readonly SnapshotEntry[]) {
  const summary = { added: 0, modified: 0, deleted: 0 }
  const changedFiles = entries.map(entry => {
    const status = changeStatus[entry.change]
    summary[status] += 1
    return { path: entry.path, status }
  })
  return { changedFiles, summary, hasChanges: changedFiles.length > 0 }
}
