import { commitFiles, enablePages, type FileWrite } from '@/lib/github'
import { JobRuntimeError } from '../errors'

type CreatedRepository = {
  fullName: string
  defaultBranch: string
  htmlUrl: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'mychat-agent-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** GitHub's create-repository API has no idempotency key. This exact variant
 * never chooses a suffix: an uncertain running effect is fenced from retry. */
export async function createRepositoryExact(input: {
  token: string
  login: string
  name: string
  description: string
  isPrivate: boolean
}): Promise<CreatedRepository> {
  const response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: headers(input.token),
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      private: input.isPrivate,
      auto_init: true,
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(error => {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'GitHub repository creation is unavailable', {
      class: 'provider', cause: error,
    })
  })
  const body = record(await response.json().catch(() => null))
  if (!response.ok) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'GitHub rejected exact repository creation', {
    class: 'provider', retryable: false,
    details: { status: response.status },
  })
  const expected = `${input.login}/${input.name}`.toLowerCase()
  if (typeof body?.full_name !== 'string' || body.full_name.toLowerCase() !== expected
      || typeof body.default_branch !== 'string' || typeof body.html_url !== 'string') {
    throw new JobRuntimeError('JOB_CONFLICT', 'GitHub created a repository outside the confirmed plan', {
      class: 'policy',
    })
  }
  return {
    fullName: body.full_name,
    defaultBranch: body.default_branch,
    htmlUrl: body.html_url,
  }
}

export async function commitInitialFiles(input: {
  token: string
  repo: string
  branch: string
  files: FileWrite[]
  message: string
}): Promise<{ commitSha: string }> {
  const result = await commitFiles(
    input.token, input.repo, input.branch, input.files, input.message || 'Agent: initial repository',
  )
  if ('error' in result) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', result.error, {
    class: 'provider', retryable: false,
  })
  return result
}

export async function deployInitialPages(input: {
  token: string
  repo: string
  branch: string
  commitSha?: string
  isPrivate: boolean
}) {
  const result = await enablePages(input.token, input.repo, input.branch, {
    verifyUrl: !input.isPrivate,
    expectedCommitSha: input.commitSha,
  })
  if (result.status === 'failed') throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', result.error, {
    class: 'provider', retryable: false,
  })
  return result
}
