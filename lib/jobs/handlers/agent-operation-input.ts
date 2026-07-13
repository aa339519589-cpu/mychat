import type { SupabaseClient } from '@supabase/supabase-js'
import { sha256 } from '@/lib/agent/confirmation-plan'
import { parseCodeApplyRequest } from '@/lib/code-agent/apply-request'
import { sha256JobValue } from '../canonical'
import type { JsonObject } from '../contracts'
import { JobRuntimeError } from '../errors'
import type { JobExecutionContext } from '../worker'

export type LoadedAgentOperation = {
  client: SupabaseClient
  userId: string
  taskId: string
  kind: 'initial_repository' | 'workspace_publish'
  message: string
  actions: ReturnType<typeof parseCodeApplyRequest>['actions']
  targetRepo: string | null
  deployPages: boolean
  snapshot: {
    snapshotId: string
    manifestDigest: string
    treeDigest: string
    head: string
  } | null
  plan: {
    repo: string | null
    baseBranch: string
    workspaceBranch: string | null
    head: string | null
    workspaceStateSha256: string
    payload: Record<string, unknown>
  }
}

function record(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown> : null
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new JobRuntimeError('JOB_INVALID_INPUT', `Missing ${name}`)
  return value
}

function digest(value: unknown, name: string): string {
  const result = requiredString(value, name)
  if (!/^[0-9a-f]{64}$/.test(result)) throw new JobRuntimeError('JOB_INVALID_INPUT', `Invalid ${name}`)
  return result
}

async function readAuthority(context: JobExecutionContext, client: SupabaseClient) {
  const { data, error } = await client.rpc('read_agent_operation_authority', {
    input_job_id: context.job.id,
    input_worker_id: context.fence.workerId,
    input_lease_version: context.fence.leaseVersion,
  })
  const result = record(data)
  if (error || result?.ok !== true) {
    throw new JobRuntimeError('JOB_LEASE_STALE', 'Agent operation authority fence was rejected')
  }
  const canonical = requiredString(result.planCanonical, 'planCanonical')
  const planHash = digest(result.planHash, 'planHash')
  if (sha256(canonical) !== planHash) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Confirmation plan hash mismatch', { class: 'policy' })
  }
  let plan: unknown
  try { plan = JSON.parse(canonical) } catch {
    throw new JobRuntimeError('JOB_CONFLICT', 'Confirmation plan is not canonical JSON', { class: 'policy' })
  }
  return { result, plan: record(plan), planHash }
}

/** Revalidate every persisted binding before touching a workspace or GitHub. */
export async function loadAgentOperation(
  context: JobExecutionContext,
  client: SupabaseClient,
): Promise<LoadedAgentOperation> {
  const userId = context.job.principal.id
  const payload = record(context.job.input)
  if (!payload || payload.schemaVersion !== 1) throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid operation payload')
  const taskId = requiredString(payload.taskId, 'taskId')
  if (context.job.subject.taskId !== taskId) throw new JobRuntimeError('JOB_CONFLICT', 'Operation task binding mismatch')
  const kind = payload.kind
  if (kind !== 'initial_repository' && kind !== 'workspace_publish') {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid operation kind')
  }
  const targetRepo = payload.targetRepo === null ? null : requiredString(payload.targetRepo, 'targetRepo')
  const request = parseCodeApplyRequest({
    repo: targetRepo,
    taskId,
    mode: kind === 'workspace_publish' ? 'workspace_pr' : 'direct_push',
    actions: payload.actions,
    message: payload.message,
  })
  const snapshotSource = payload.snapshot === null ? null : record(payload.snapshot)
  const snapshot = snapshotSource ? {
    snapshotId: requiredString(snapshotSource.snapshotId, 'snapshotId'),
    manifestDigest: digest(snapshotSource.manifestDigest, 'manifestDigest'),
    treeDigest: digest(snapshotSource.treeDigest, 'treeDigest'),
    head: requiredString(snapshotSource.head, 'snapshotHead'),
  } : null
  if ((kind === 'workspace_publish') !== Boolean(snapshot)) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Operation snapshot binding mismatch', { class: 'policy' })
  }
  const operation = {
    schemaVersion: 1,
    kind,
    taskId,
    message: request.message,
    actions: request.actions,
    targetRepo,
    deployPages: payload.deployPages === true,
    snapshot,
  }
  const operationHash = digest(payload.operationHash, 'operationHash')
  if (sha256JobValue(operation as unknown as JsonObject) !== operationHash) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Operation payload hash mismatch', { class: 'policy' })
  }

  const authority = await readAuthority(context, client)
  const plan = authority.plan
  const planPayload = record(plan?.payload)
  if (!plan || plan.version !== 1 || plan.userId !== userId || plan.taskId !== taskId
      || plan.operation !== 'publish' || planPayload?.kind !== kind
      || planPayload.operationInputSha256 !== operationHash
      || payload.planHash !== authority.planHash) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Operation does not match confirmed plan', { class: 'policy' })
  }
  if (kind === 'workspace_publish' && (
    authority.result.snapshotId !== snapshot?.snapshotId
    || authority.result.snapshotDigest !== snapshot?.manifestDigest
    || plan.head !== snapshot?.head
    || plan.workspaceStateSha256 !== snapshot?.manifestDigest
    || plan.repo !== targetRepo
  )) throw new JobRuntimeError('JOB_CONFLICT', 'Workspace CAS authority changed', { class: 'policy' })
  if (kind === 'initial_repository' && (
    authority.result.snapshotId !== null || authority.result.snapshotDigest !== null || plan.repo !== null
  )) throw new JobRuntimeError('JOB_CONFLICT', 'Initial repository authority is invalid', { class: 'policy' })

  if (kind === 'workspace_publish') {
    const { data: currentHead, error } = await client.from('agent_workspace_heads')
      .select('snapshot_id,manifest_digest,tree_digest,head')
      .eq('task_id', taskId).eq('user_id', userId).maybeSingle()
    if (error || !currentHead
        || currentHead.snapshot_id !== snapshot?.snapshotId
        || currentHead.manifest_digest !== snapshot?.manifestDigest
        || currentHead.tree_digest !== snapshot?.treeDigest
        || currentHead.head !== snapshot?.head) {
      throw new JobRuntimeError('JOB_CONFLICT', 'Confirmed workspace is no longer current', {
        class: 'policy', retryable: false,
      })
    }
  }

  return {
    client, userId, taskId, kind, message: request.message, actions: request.actions,
    targetRepo, deployPages: payload.deployPages === true, snapshot,
    plan: {
      repo: typeof plan.repo === 'string' ? plan.repo : null,
      baseBranch: requiredString(plan.baseBranch, 'baseBranch'),
      workspaceBranch: typeof plan.workspaceBranch === 'string' ? plan.workspaceBranch : null,
      head: typeof plan.head === 'string' ? plan.head : null,
      workspaceStateSha256: digest(plan.workspaceStateSha256, 'workspaceStateSha256'),
      payload: planPayload ?? {},
    },
  }
}
