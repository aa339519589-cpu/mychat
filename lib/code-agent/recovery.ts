import { getTaskDetail } from '@/lib/agent/data'
import { readOwnedJob } from '@/lib/jobs/read-model'
import type { SupabaseClient } from '@/lib/supabase/types'
import type { PublicJobSnapshot } from '@/lib/jobs/read-model'

async function latestOperationAdmission(client: SupabaseClient, userId: string, job: PublicJobSnapshot, signal?: AbortSignal) {
  const operation = await client.from('jobs').select('id')
    .eq('principal_id', userId).eq('type', 'agent.operation')
    .contains('subject', { taskId: job.subject.taskId })
    .order('created_at', { ascending: false }).limit(1)
    .abortSignal(signal ?? AbortSignal.timeout(8_000)).maybeSingle()
  if (operation.error) throw new Error('发布状态暂时不可用')
  if (!operation.data) return null
  const snapshot = await readOwnedJob(client, userId, operation.data.id, signal)
  if (!snapshot.ok) throw new Error('发布状态暂时不可用')
  const publication = snapshot.value
  if (publication.createdAt < job.createdAt) return null
  return {
    schemaVersion: 1, jobId: publication.id, taskId: job.subject.taskId,
    status: publication.status, created: false,
    streamUrl: `/api/v1/jobs/${publication.id}/events?from_seq=0`, eventSequence: publication.eventSequence,
  }
}

export async function readCodeRecovery(client: SupabaseClient, userId: string,
  selector: { taskId?: string; sessionId?: string }, signal?: AbortSignal) {
  const subject = selector.taskId ? { taskId: selector.taskId } : { sessionId: selector.sessionId! }
  const latest = await client.from('jobs').select('id')
    .eq('principal_id', userId).eq('type', 'agent.task').contains('subject', subject)
    .order('created_at', { ascending: false }).limit(1)
    .abortSignal(signal ?? AbortSignal.timeout(8_000)).maybeSingle()
  if (latest.error) throw new Error('任务恢复服务暂时不可用')
  if (!latest.data) {
    if (!selector.taskId) return { task: null, admission: null }
    const task = await getTaskDetail(client, userId, selector.taskId)
    return { task: 'error' in task ? null : task, admission: null }
  }
  const snapshot = await readOwnedJob(client, userId, latest.data.id, signal)
  if (!snapshot.ok) throw new Error('任务状态暂时不可用')
  const job = snapshot.value
  if (typeof job.subject.taskId !== 'string' || typeof job.subject.responseId !== 'string'
    || (selector.sessionId && job.subject.sessionId !== selector.sessionId)) throw new Error('任务恢复关联无效')
  const task = await getTaskDetail(client, userId, job.subject.taskId)
  if ('error' in task) return { task: null, admission: null }
  const operationAdmission = await latestOperationAdmission(client, userId, job, signal)
  return { task, operationAdmission, sessionId: typeof job.subject.sessionId === 'string' ? job.subject.sessionId : null, admission: {
    schemaVersion: 1, jobId: job.id, taskId: job.subject.taskId,
    responseId: job.subject.responseId, status: job.status, created: false,
    streamUrl: `/api/v1/jobs/${job.id}/events?from_seq=0`, eventSequence: job.eventSequence,
  } }
}
