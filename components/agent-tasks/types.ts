export type WorkspaceDiff = {
  diff: string
  changedFiles: { path: string; status: string }[]
  summary: { added: number; modified: number; deleted: number }
  hasChanges: boolean
}

export type RestoreResponse = {
  ok: boolean
  error?: string
  restoredFiles?: number
  failedFiles?: number
  usedSource?: "local_cas" | "artifact_cas" | "none"
  snapshotId?: string
  diff?: string
  changedFiles?: { path: string; status: string }[]
}

export type SnapshotListResponse = {
  ok: boolean
  snapshots?: {
    snapshotId: string
    changedFiles: string[]
    createdAt: string
    reason: string
    storage: string
    restorable: boolean
  }[]
}

export type GitStatusData = {
  ok: boolean
  currentBranch?: string
  changedFiles?: { path: string; status: string }[]
  hasChanges?: boolean
  commitSha?: string
  error?: string
}

export type DetectedCommands = {
  packageManager: string
  framework: string
  confidence: number
  installCommand: string | null
  lintCommand: string | null
  typecheckCommand: string | null
  testCommand: string | null
  buildCommand: string | null
  notes: string[]
}

export type VerifyStep = {
  name: string
  command: string | null
  skipped: boolean
  skipReason?: string
  passed: boolean
  durationMs: number
  parsedErrors: {
    totalErrors: number
    totalWarnings: number
    summary: string
    errors: { file: string | null; line: number | null; message: string; severity: string }[]
  }
}

export type VerifyData = {
  ok: boolean
  steps: VerifyStep[]
  failedStep: string | null
  totalDurationMs: number
  summary: string
}

export type PendingConfirmation = {
  id: string
  operation: string
  riskLevel: string
  title: string
  reason: string
  files: string[]
  status: string
  confirmationToken?: string
  expiresAt?: string
}

export type PublishResult = {
  ok: boolean
  pr?: { pullRequestUrl?: string }
  error?: string
  stage?: string
}
