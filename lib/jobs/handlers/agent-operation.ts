import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createWorkspaceForTask } from '@/lib/agent/workspace'
import { workspaceRoot } from '@/lib/agent/workspace-paths'
import { restoreWorkspaceSnapshot } from '@/lib/agent/snapshot'
import { publishWorkspaceToPullRequest } from '@/lib/agent/git-publish'
import { getGitHubCredentialForUser } from '@/lib/github-connection'
import { enablePages, mergePullRequest, repoMeta, type FileWrite } from '@/lib/github'
import { createAdminClient } from '@/lib/supabase/admin'
import type { JsonObject } from '../contracts'
import { JobRuntimeError } from '../errors'
import { JobEventWriter, jsonResult } from '../event-writer'
import { executeFencedToolEffect } from '../tool-effects'
import type { JobExecutionContext, JobHandler } from '../worker'
import { loadAgentOperation } from './agent-operation-input'
import {
  commitInitialFiles,
  createRepositoryExact,
  deployInitialPages,
} from './agent-operation-github'

function parseEffect<T>(value: string): T {
  try { return JSON.parse(value) as T } catch {
    throw new JobRuntimeError('JOB_CONFLICT', 'Persisted tool effect result is malformed')
  }
}

async function effect<T>(context: JobExecutionContext, input: {
  id: string
  name: string
  args: JsonObject
  replaySafe?: boolean
  execute: () => Promise<T>
}): Promise<T> {
  const result = await executeFencedToolEffect({
    client: createAdminClient()!,
    fence: context.fence,
    toolCallId: input.id,
    toolName: input.name,
    args: input.args,
    replaySafe: input.replaySafe === true,
    execute: async () => JSON.stringify(await input.execute()),
  })
  context.assertAuthority()
  return parseEffect<T>(result.result)
}

function gitAuthEnvironment(token: string): NodeJS.ProcessEnv {
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    ...process.env,
    GIT_ASKPASS: 'echo',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
  }
}

function checkoutSnapshotHead(root: string, token: string, branch: string, head: string): void {
  const options = {
    cwd: root,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8' as const,
    env: gitAuthEnvironment(token),
  }
  try {
    execFileSync('git', ['cat-file', '-e', `${head}^{commit}`], options)
  } catch {
    execFileSync('git', ['fetch', '--no-tags', 'origin', head], options)
  }
  execFileSync('git', ['checkout', '-B', branch, head], options)
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], options).trim()
  if (actual !== head) throw new JobRuntimeError('JOB_CONFLICT', 'Workspace HEAD restore mismatch')
}

async function bindInitialRepository(
  context: JobExecutionContext,
  repo: string,
  branch: string,
): Promise<void> {
  const client = createAdminClient()
  if (!client) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable')
  const { data, error } = await client.rpc('bind_agent_operation_repository', {
    input_job_id: context.job.id,
    input_worker_id: context.fence.workerId,
    input_lease_version: context.fence.leaseVersion,
    input_repo: repo,
    input_branch: branch,
  })
  const value = Array.isArray(data) ? data[0] : data
  if (error || !value || typeof value !== 'object' || (value as { ok?: unknown }).ok !== true) {
    throw new JobRuntimeError('JOB_LEASE_STALE', 'Repository authority binding was rejected')
  }
}

async function initialRepository(
  context: JobExecutionContext,
  writer: JobEventWriter,
  input: Awaited<ReturnType<typeof loadAgentOperation>>,
  token: string,
  login: string,
) {
  const create = input.actions.find(action => action.kind === 'create_repo')
  if (!create || create.kind !== 'create_repo') {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Missing create_repo action')
  }
  await writer.append('agent.step', { step: { kind: 'tool_call', label: '创建 GitHub 仓库' } })
  const repository = await effect(context, {
    id: 'initial:create-repository',
    name: 'github.create_repository',
    args: { login, name: create.name, private: create.private === true },
    execute: () => createRepositoryExact({
      token, login, name: create.name,
      description: create.description ?? '', isPrivate: create.private === true,
    }),
  })
  await bindInitialRepository(context, repository.fullName, repository.defaultBranch)

  const files: FileWrite[] = []
  for (const action of input.actions) {
    if (action.kind === 'write_file') files.push({ path: action.path, content: action.newContent })
    if (action.kind === 'delete_file') files.push({ path: action.path, content: null })
  }
  const committed = await effect(context, {
    id: 'initial:commit-files',
    name: 'github.commit_files',
    args: {
      repo: repository.fullName,
      branch: repository.defaultBranch,
      files: files.map(file => ({ path: file.path, deleted: file.content === null })),
    },
    execute: () => commitInitialFiles({
      token, repo: repository.fullName, branch: repository.defaultBranch,
      files, message: input.message,
    }),
  })
  let pages: Awaited<ReturnType<typeof deployInitialPages>> | undefined
  if (input.deployPages) {
    pages = await effect(context, {
      id: 'initial:deploy-pages',
      name: 'github.enable_pages',
      args: { repo: repository.fullName, branch: repository.defaultBranch, commitSha: committed.commitSha },
      execute: () => deployInitialPages({
        token, repo: repository.fullName, branch: repository.defaultBranch,
        commitSha: committed.commitSha, isPrivate: create.private === true,
      }),
    })
  }
  return {
    schemaVersion: 1, mode: 'direct_push', taskId: input.taskId,
    created: true,
    repo: repository.fullName, repoUrl: repository.htmlUrl,
    branch: repository.defaultBranch, commitSha: committed.commitSha,
    pagesUrl: pages?.url, pagesStatus: pages?.status,
    changedFiles: files.map(file => file.path), irreversibleCommitted: true,
  }
}

async function workspacePublish(
  context: JobExecutionContext,
  writer: JobEventWriter,
  input: Awaited<ReturnType<typeof loadAgentOperation>>,
  token: string,
) {
  if (!input.targetRepo || !input.snapshot || !input.plan.workspaceBranch) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Workspace publish authority is incomplete')
  }
  const metadata = await repoMeta(token, input.targetRepo)
  if (!metadata?.canPush) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Repository write access is unavailable', {
    class: 'policy', retryable: false,
  })
  const root = workspaceRoot(input.taskId, input.userId)
  if (!existsSync(root)) {
    const created = await createWorkspaceForTask(
      input.client, input.userId, input.taskId, token, input.targetRepo,
      'durable publish restore', input.plan.baseBranch, false,
    )
    if ('error' in created) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', created.error)
  }
  checkoutSnapshotHead(root, token, input.plan.workspaceBranch, input.snapshot.head)
  const restored = await restoreWorkspaceSnapshot(
    input.taskId, input.userId, input.snapshot.snapshotId, input.client,
  )
  if (!restored.ok) throw new JobRuntimeError('JOB_CONFLICT', restored.error ?? 'CAS snapshot restore failed', {
    class: 'policy', retryable: false,
  })
  await writer.append('agent.step', { step: {
    kind: 'tool_result', label: '已恢复并校验确认时的 CAS workspace',
    detail: `${restored.restoredFiles} paths`,
  } })

  const published = await effect(context, {
    id: 'workspace:publish-pr',
    name: 'github.publish_pull_request',
    args: {
      repo: input.targetRepo, snapshotId: input.snapshot.snapshotId,
      manifestDigest: input.snapshot.manifestDigest, branch: input.plan.workspaceBranch,
    },
    execute: async () => {
      const result = await publishWorkspaceToPullRequest(
        input.taskId, input.userId, token, input.client, { message: input.message },
      )
      if (!result.ok) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', result.error ?? 'Pull Request publish failed', {
        class: 'provider', retryable: false,
      })
      return result
    },
  })
  let merged = false
  let mergeCommitSha: string | undefined
  let pages: Awaited<ReturnType<typeof enablePages>> | undefined
  if (input.deployPages) {
    const pullNumber = published.pr?.pullRequestNumber
    const headSha = published.commit?.commitSha
    if (!pullNumber || !headSha) throw new JobRuntimeError('JOB_CONFLICT', 'Published PR lacks merge authority')
    const merge = await effect(context, {
      id: 'workspace:merge-pr', name: 'github.merge_pull_request',
      args: { repo: input.targetRepo, pullNumber, headSha },
      execute: () => mergePullRequest(token, input.targetRepo!, pullNumber, headSha),
    })
    if (!merge.merged) throw new JobRuntimeError('JOB_CONFLICT', merge.error, { class: 'policy', retryable: false })
    merged = true
    mergeCommitSha = merge.commitSha
    pages = await effect(context, {
      id: 'workspace:deploy-pages', name: 'github.enable_pages',
      args: { repo: input.targetRepo, branch: metadata.defaultBranch, commitSha: mergeCommitSha },
      execute: () => enablePages(token, input.targetRepo!, metadata.defaultBranch, {
        verifyUrl: !metadata.isPrivate, expectedCommitSha: mergeCommitSha,
      }),
    })
    if (pages.status === 'failed') throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', pages.error, {
      class: 'provider', retryable: false,
    })
  }
  return {
    schemaVersion: 1, mode: 'workspace_pr', taskId: input.taskId,
    repo: input.targetRepo, pullRequestUrl: published.pr?.pullRequestUrl,
    pullRequestNumber: published.pr?.pullRequestNumber,
    commitSha: published.commit?.commitSha, branch: published.push?.branch,
    merged, mergeCommitSha, pagesUrl: pages?.url, pagesStatus: pages?.status,
    changedFiles: published.status?.changedFiles, irreversibleCommitted: true,
  }
}

export const handleAgentOperation: JobHandler = async context => {
  const client = createAdminClient()
  if (!client) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable')
  const input = await loadAgentOperation(context, client)
  const credential = await getGitHubCredentialForUser(input.userId, {
    actorType: 'worker', actorId: context.fence.workerId,
    purpose: 'agent.operation', requestId: context.job.id,
  })
  if (!credential) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'GitHub credential is unavailable', {
    class: 'policy', retryable: false,
  })
  const writer = new JobEventWriter(context)
  await writer.append('job.started', { taskId: input.taskId, operation: input.kind })
  const result = input.kind === 'initial_repository'
    ? await initialRepository(context, writer, input, credential.token, credential.login)
    : await workspacePublish(context, writer, input, credential.token)
  await writer.drain()
  return { status: 'completed', result: jsonResult(result) }
}
