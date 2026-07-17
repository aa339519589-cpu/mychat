import type { SupabaseClient } from '@/lib/supabase/types'
import { createConfirmationRequest } from '@/lib/agent/permissions'
import { createAgentConfirmationToken, sha256 } from '@/lib/agent/confirmation-plan'
import { sha256JobValue } from '@/lib/jobs/canonical'
import type { JobRecord } from '@/lib/jobs/contracts'
import type { PreparedAgentOperation } from './operation-plan'

type EnqueueResponse = {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

function record(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown> : null
}

function rpcError(reason: unknown): { status: number; message: string } {
  switch (reason) {
    case 'expired': return { status: 409, message: '确认已过期，请重新检查发布计划' }
    case 'plan_mismatch': return { status: 409, message: '发布计划已变化，原确认已失效' }
    case 'not_approved': return { status: 409, message: '发布计划尚未获得用户确认' }
    case 'already_consumed': return { status: 409, message: '确认已被其他操作消费' }
    case 'invalid_confirmation': return { status: 403, message: '确认凭据无效' }
    default: return { status: 409, message: '确认状态已变化，请重新发起' }
  }
}

export async function requestOrEnqueueAgentOperation(input: {
  client: SupabaseClient
  commandClient: SupabaseClient
  userId: string
  authClass: 'anonymous' | 'registered'
  prepared: PreparedAgentOperation
  confirmation?: { confirmationId: string; confirmationToken: string }
}): Promise<EnqueueResponse> {
  const { client, commandClient, userId, prepared, confirmation } = input
  if (!confirmation) {
    let gate: {
      id: string
      expiresAt: string
      confirmationToken?: string
    }
    if (prepared.operation.kind === 'initial_repository') {
      const create = prepared.operation.actions.find(action => action.kind === 'create_repo')
      const { token, tokenSha256 } = createAgentConfirmationToken()
      const { data, error } = await client.rpc('create_agent_operation_confirmation', {
        input_user_id: userId,
        input_task_id: prepared.taskId,
        input_goal: create?.kind === 'create_repo'
          ? `创建并发布 ${create.name}` : '创建并发布代码仓库',
        input_plan_canonical: prepared.planCanonical,
        input_token_sha256: tokenSha256,
        input_title: prepared.risk.title,
        input_reason: prepared.risk.reason,
        input_files: prepared.risk.files.slice(0, 100),
      })
      const result = record(data)
      if (error || result?.ok !== true || typeof result.id !== 'string'
          || typeof result.expiresAt !== 'string') {
        throw new Error('无法原子创建发布任务与确认门')
      }
      gate = { id: result.id, expiresAt: result.expiresAt, confirmationToken: token }
    } else {
      gate = await createConfirmationRequest(
        client,
        userId,
        prepared.taskId,
        prepared.risk,
        prepared.plan,
        'queued',
      )
    }
    return {
      status: 409,
      body: {
        error: '高风险代码发布需要单次确认',
        needsConfirmation: true,
        taskId: prepared.taskId,
        confirmationId: gate.id,
        confirmationToken: gate.confirmationToken,
        operation: 'publish',
        expiresAt: gate.expiresAt,
        risk: prepared.risk,
        planHash: prepared.planHash,
      },
    }
  }

  const payload = {
    ...prepared.operation,
    operationHash: prepared.operationHash,
    planHash: prepared.planHash,
  }
  const jobId = crypto.randomUUID()
  const { data, error } = await commandClient.rpc('enqueue_agent_operation', {
    input_user_id: userId,
    input_task_id: prepared.taskId,
    input_confirmation_id: confirmation.confirmationId,
    input_operation: 'publish',
    input_plan_canonical: prepared.planCanonical,
    input_token_sha256: sha256(confirmation.confirmationToken),
    input_job_id: jobId,
    input_auth_class: input.authClass,
    input_idempotency_key: `agent-operation:${confirmation.confirmationId}`,
    input_input_hash: sha256JobValue(payload),
    input_payload: payload,
    input_snapshot_id: prepared.operation.snapshot?.snapshotId ?? null,
    input_snapshot_digest: prepared.operation.snapshot?.manifestDigest ?? null,
  })
  if (error) throw new Error('发布作业原子入队失败')
  const result = record(data)
  if (result?.enqueued !== true && result?.replayed !== true) {
    const failure = rpcError(result?.reason)
    return { status: failure.status, body: { error: failure.message, taskId: prepared.taskId } }
  }
  const job = record(result.job) as unknown as JobRecord | null
  if (!job || typeof job.id !== 'string' || typeof job.status !== 'string') {
    throw new Error('发布作业入队结果无效')
  }
  const streamUrl = `/api/v1/jobs/${job.id}/events?from_seq=0`
  return {
    status: 202,
    body: {
      schemaVersion: 1,
      jobId: job.id,
      taskId: prepared.taskId,
      status: job.status,
      created: result.enqueued === true && result.replayed !== true,
      streamUrl,
    },
    headers: {
      'Cache-Control': 'no-store',
      Location: `/api/v1/jobs/${job.id}`,
    },
  }
}
