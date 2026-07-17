import type { SupabaseClient } from '@/lib/supabase/types'
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function rpcRecord(value: unknown): Record<string, unknown> | null {
  return objectRecord(Array.isArray(value) ? value[0] : value)
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
  const result = rpcRecord(data)
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
  return { result, plan: objectRecord(plan), planHash }
}

type OperationKind = LoadedAgentOperation['kind']
type OperationSnapshot = LoadedAgentOperation['snapshot']

function operationKind(value: unknown): OperationKind {
  if (value === 'initial_repository' || value === 'workspace_publish') return value
  throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid operation kind')
}

function operationSnapshot(value: unknown): OperationSnapshot {
  if (value === null) return null
  const source = objectRecord(value)
  if (!source) throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid operation snapshot')
  return {
    snapshotId: requiredString(source.snapshotId, 'snapshotId'),
    manifestDigest: digest(source.manifestDigest, 'manifestDigest'),
    treeDigest: digest(source.treeDigest, 'treeDigest'),
    head: requiredString(source.head, 'snapshotHead'),
  }
}

function parseOperationPayload(context: JobExecutionContext) {
  const payload = objectRecord(context.job.input)
  if (!payload || payload.schemaVersion !== 1) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid operation payload')
  }
  const taskId = requiredString(payload.taskId, 'taskId')
  if (context.job.subject.taskId !== taskId) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Operation task binding mismatch')
  }
  const kind = operationKind(payload.kind)
  const targetRepo = payload.targetRepo === null
    ? null
    : requiredString(payload.targetRepo, 'targetRepo')
  const request = parseCodeApplyRequest({
    repo: targetRepo,
    taskId,
    mode: kind === 'workspace_publish' ? 'workspace_pr' : 'direct_push',
    actions: payload.actions,
    message: payload.message,
  })
  const snapshot = operationSnapshot(payload.snapshot)
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
  return { payload, taskId, kind, targetRepo, request, snapshot, operationHash }
}

function validateConfirmedPlan(input: {
  plan: Record<string, unknown> | null
  authority: Awaited<ReturnType<typeof readAuthority>>
  payload: Record<string, unknown>
  userId: string
  taskId: string
  kind: OperationKind
  operationHash: string
}): Record<string, unknown> {
  const planPayload = objectRecord(input.plan?.payload)
  if (!input.plan
    || input.plan.version !== 1
    || input.plan.userId !== input.userId
    || input.plan.taskId !== input.taskId
    || input.plan.operation !== 'publish'
    || planPayload?.kind !== input.kind
    || planPayload.operationInputSha256 !== input.operationHash
    || input.payload.planHash !== input.authority.planHash) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Operation does not match confirmed plan', { class: 'policy' })
  }
  return planPayload
}

function validateWorkspaceCas(input: {
  authority: Awaited<ReturnType<typeof readAuthority>>
  snapshot: NonNullable<OperationSnapshot>
  targetRepo: string | null
}): void {
  const plan = input.authority.plan
  if (!plan
    || input.authority.result.snapshotId !== input.snapshot.snapshotId
    || input.authority.result.snapshotDigest !== input.snapshot.manifestDigest
    || plan.head !== input.snapshot.head
    || plan.workspaceStateSha256 !== input.snapshot.manifestDigest
    || plan.repo !== input.targetRepo) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Workspace CAS authority changed', { class: 'policy' })
  }
}

function validateInitialCas(authority: Awaited<ReturnType<typeof readAuthority>>): void {
  if (!authority.plan
    || authority.result.snapshotId !== null
    || authority.result.snapshotDigest !== null
    || authority.plan.repo !== null) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Initial repository authority is invalid', { class: 'policy' })
  }
}

function validateCasAuthority(input: {
  kind: OperationKind
  authority: Awaited<ReturnType<typeof readAuthority>>
  snapshot: OperationSnapshot
  targetRepo: string | null
}): void {
  if (input.kind === 'initial_repository') {
    validateInitialCas(input.authority)
    return
  }
  if (!input.snapshot) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Operation snapshot binding mismatch', { class: 'policy' })
  }
  validateWorkspaceCas({
    authority: input.authority,
    snapshot: input.snapshot,
    targetRepo: input.targetRepo,
  })
}

async function validateCurrentWorkspace(input: {
  client: SupabaseClient
  kind: OperationKind
  taskId: string
  userId: string
  snapshot: OperationSnapshot
}): Promise<void> {
  if (input.kind !== 'workspace_publish' || !input.snapshot) return
  const { data, error } = await input.client.from('agent_workspace_heads')
    .select('snapshot_id,manifest_digest,tree_digest,head')
    .eq('task_id', input.taskId).eq('user_id', input.userId).maybeSingle()
  if (error || !data
    || data.snapshot_id !== input.snapshot.snapshotId
    || data.manifest_digest !== input.snapshot.manifestDigest
    || data.tree_digest !== input.snapshot.treeDigest
    || data.head !== input.snapshot.head) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Confirmed workspace is no longer current', {
      class: 'policy', retryable: false,
    })
  }
}

function loadedPlan(
  plan: Record<string, unknown>,
  payload: Record<string, unknown>,
): LoadedAgentOperation['plan'] {
  return {
    repo: typeof plan.repo === 'string' ? plan.repo : null,
    baseBranch: requiredString(plan.baseBranch, 'baseBranch'),
    workspaceBranch: typeof plan.workspaceBranch === 'string' ? plan.workspaceBranch : null,
    head: typeof plan.head === 'string' ? plan.head : null,
    workspaceStateSha256: digest(plan.workspaceStateSha256, 'workspaceStateSha256'),
    payload,
  }
}

/** Revalidate every persisted binding before touching a workspace or GitHub. */
export async function loadAgentOperation(
  context: JobExecutionContext,
  client: SupabaseClient,
): Promise<LoadedAgentOperation> {
  const userId = context.job.principal.id
  const parsed = parseOperationPayload(context)
  const authority = await readAuthority(context, client)
  const planPayload = validateConfirmedPlan({
    plan: authority.plan,
    authority,
    payload: parsed.payload,
    userId,
    taskId: parsed.taskId,
    kind: parsed.kind,
    operationHash: parsed.operationHash,
  })
  validateCasAuthority({
    kind: parsed.kind,
    authority,
    snapshot: parsed.snapshot,
    targetRepo: parsed.targetRepo,
  })
  await validateCurrentWorkspace({
    client,
    kind: parsed.kind,
    taskId: parsed.taskId,
    userId,
    snapshot: parsed.snapshot,
  })
  if (!authority.plan) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Operation does not match confirmed plan', { class: 'policy' })
  }
  return {
    client,
    userId,
    taskId: parsed.taskId,
    kind: parsed.kind,
    message: parsed.request.message,
    actions: parsed.request.actions,
    targetRepo: parsed.targetRepo,
    deployPages: parsed.payload.deployPages === true,
    snapshot: parsed.snapshot,
    plan: loadedPlan(authority.plan, planPayload),
  }
}
