export type GitStatus = {
  ok: boolean
  error?: string
  currentBranch?: string
  changedFiles?: { path: string; status: string }[]
  diffStat?: string
  diffPreview?: string
  hasChanges?: boolean
  commitSha?: string | null
}

export type CommitResult = {
  ok: boolean
  error?: string
  commitSha?: string
  message?: string
  changedFiles?: string[]
  diffStat?: string
}

export type PushResult = {
  ok: boolean
  error?: string
  branch?: string
  remote?: string
}

export type PRResult = {
  ok: boolean
  error?: string
  pullRequestUrl?: string
  pullRequestNumber?: number
  title?: string
  head?: string
  base?: string
}

export type PublishResult = {
  ok: boolean
  error?: string
  stage?: string
  status?: GitStatus
  commit?: CommitResult
  push?: PushResult
  pr?: PRResult
}
