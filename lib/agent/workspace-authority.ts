import type { SupabaseClient } from '@/lib/supabase/types'
import type { JobExecutionContext } from '@/lib/jobs/worker'
import { JobRuntimeError } from '@/lib/jobs/errors'
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from './snapshot'
import { workspaceRoot } from './workspace-paths'
import { runGit } from './git-publish/git-command'

export type WorkspaceAuthority = {
  taskId: string
  userId: string
  snapshotId: string
  manifestDigest: string
  treeDigest: string
  head: string
  version: number
}

function authEnvironment(token: string): NodeJS.ProcessEnv {
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    ...process.env,
    GIT_ASKPASS: 'echo', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
  }
}

async function checkoutExactHead(
  root: string,
  token: string,
  branch: string,
  head: string,
  signal?: AbortSignal,
): Promise<void> {
  const options = {
    cwd: root, timeoutMs: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: authEnvironment(token), signal,
  }
  try {
    await runGit(['cat-file', '-e', `${head}^{commit}`], options)
  } catch {
    signal?.throwIfAborted()
    await runGit(['fetch', '--no-tags', 'origin', head], options)
  }
  await runGit(['checkout', '-B', branch, head], options)
  if ((await runGit(['rev-parse', 'HEAD'], options)).trim() !== head) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Workspace authority HEAD mismatch', {
      class: 'policy', retryable: false,
    })
  }
}

export async function readWorkspaceAuthority(
  client: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<WorkspaceAuthority | null> {
  const { data, error } = await client.from('agent_workspace_heads')
    .select('task_id,user_id,snapshot_id,manifest_digest,tree_digest,head,version')
    .eq('task_id', taskId).eq('user_id', userId).maybeSingle()
  if (error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Workspace authority is unavailable')
  if (!data) return null
  return {
    taskId: String(data.task_id), userId: String(data.user_id), snapshotId: String(data.snapshot_id),
    manifestDigest: String(data.manifest_digest), treeDigest: String(data.tree_digest),
    head: String(data.head), version: Number(data.version),
  }
}

export async function advanceWorkspaceAuthority(
  context: JobExecutionContext,
  client: SupabaseClient,
  userId: string,
  taskId: string,
  reason: string,
): Promise<WorkspaceAuthority> {
  context.assertAuthority()
  const created = await createWorkspaceSnapshot(taskId, userId, `authority:${reason}`, client)
  if (!created.ok || !created.snapshot.manifestDigest || !created.snapshot.treeDigest || !created.snapshot.head) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE',
      created.ok ? 'Workspace authority snapshot is incomplete' : created.error,
      { class: 'provider' },
    )
  }
  const snapshot = created.snapshot
  const manifestDigest = snapshot.manifestDigest!
  const treeDigest = snapshot.treeDigest!
  const head = snapshot.head!
  const { data, error } = await client.rpc('advance_agent_workspace_head', {
    input_job_id: context.job.id,
    input_worker_id: context.fence.workerId,
    input_lease_version: context.fence.leaseVersion,
    input_snapshot_id: snapshot.snapshotId,
    input_manifest_digest: manifestDigest,
    input_tree_digest: treeDigest,
    input_head: head,
  })
  const value = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (error || value?.ok !== true) {
    throw new JobRuntimeError(
      value?.reason === 'stale_fence' ? 'JOB_LEASE_STALE' : 'JOB_DEPENDENCY_UNAVAILABLE',
      'Workspace authority pointer advance was rejected',
    )
  }
  return {
    taskId, userId, snapshotId: snapshot.snapshotId,
    manifestDigest, treeDigest, head, version: Number(value.version),
  }
}

export async function bindWorkspaceBranch(
  context: JobExecutionContext,
  client: SupabaseClient,
  branch: string,
): Promise<string> {
  context.assertAuthority()
  const { data, error } = await client.rpc('bind_agent_workspace_branch', {
    input_job_id: context.job.id,
    input_worker_id: context.fence.workerId,
    input_lease_version: context.fence.leaseVersion,
    input_agent_branch: branch,
  })
  const value = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
  if (error || value?.ok !== true || typeof value.agentBranch !== 'string') {
    throw new JobRuntimeError(
      value?.reason === 'stale_fence' ? 'JOB_LEASE_STALE' : 'JOB_CONFLICT',
      value?.reason === 'branch_conflict'
        ? 'Workspace branch authority conflicts with the leased task'
        : 'Workspace branch authority binding was rejected',
      { class: 'policy', retryable: false },
    )
  }
  return value.agentBranch
}

export async function restoreWorkspaceAuthority(input: {
  client: SupabaseClient
  userId: string
  taskId: string
  token: string
  branch: string
  authority: WorkspaceAuthority
  signal?: AbortSignal
}): Promise<void> {
  const root = workspaceRoot(input.taskId, input.userId)
  await checkoutExactHead(
    root, input.token, input.branch, input.authority.head, input.signal,
  )
  const restored = await restoreWorkspaceSnapshot(
    input.taskId, input.userId, input.authority.snapshotId, input.client, input.signal,
  )
  if (!restored.ok) throw new JobRuntimeError('JOB_CONFLICT', restored.error ?? 'Workspace authority restore failed', {
    class: 'policy', retryable: false,
  })
}
