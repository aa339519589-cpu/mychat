import { isJobIdentifier, isJobStatus, type JobStatus } from '@/lib/jobs/contracts'
import { isRecord } from '@/lib/unknown-value'

type QueryResult = { data: unknown; error: unknown }
type AgentTaskRecord = { id: string; repo: string; status: string }
type CodeSessionRecord = { id: string; repo: string }
type CodeMessageRecord = { id: string; sessionId: string }

const AGENT_TASK_STATUSES = new Set([
  'queued', 'planning', 'indexing', 'reading', 'editing', 'running', 'testing',
  'fixing', 'reviewing', 'waiting_for_user', 'creating_pr', 'deploying',
  'completed', 'failed', 'cancelled',
])

export class CodeAgentEnqueueContextError extends Error {
  constructor(
    public readonly kind: 'dependency' | 'conflict' | 'terminal',
    message: string,
  ) {
    super(message)
    this.name = 'CodeAgentEnqueueContextError'
  }
}

function assertAvailable(results: QueryResult[]): void {
  if (results.some(result => Boolean(result.error))) {
    throw new CodeAgentEnqueueContextError('dependency', 'Code 上下文暂时不可用')
  }
}

function optionalTask(value: unknown): AgentTaskRecord | null {
  if (value == null) return null
  if (isRecord(value) && isJobIdentifier(value.id) && typeof value.repo === 'string'
    && typeof value.status === 'string' && AGENT_TASK_STATUSES.has(value.status)) {
    return { id: value.id, repo: value.repo, status: value.status }
  }
  throw new CodeAgentEnqueueContextError('dependency', '任务上下文格式无效')
}

function sessionOf(value: unknown): CodeSessionRecord {
  if (isRecord(value) && isJobIdentifier(value.id) && typeof value.repo === 'string') {
    return { id: value.id, repo: value.repo }
  }
  throw new CodeAgentEnqueueContextError('dependency', '会话上下文格式无效')
}

function userMessageOf(value: unknown): CodeMessageRecord {
  if (isRecord(value) && isJobIdentifier(value.id) && isJobIdentifier(value.session_id)) {
    return { id: value.id, sessionId: value.session_id }
  }
  throw new CodeAgentEnqueueContextError('dependency', '消息上下文格式无效')
}

function assertBindings(input: {
  task: AgentTaskRecord | null
  session: CodeSessionRecord
  userMessage: CodeMessageRecord
  taskId: string
  sessionId: string
  repo: string
}): string {
  if (input.session.id !== input.sessionId || input.session.repo !== input.repo
    || input.userMessage.sessionId !== input.sessionId
    || (input.task && (input.task.id !== input.taskId || input.task.repo !== input.repo))) {
    throw new CodeAgentEnqueueContextError('conflict', '任务、会话或仓库上下文不一致')
  }
  return input.userMessage.id
}

function assertTaskActive(task: AgentTaskRecord | null): void {
  if (task && (task.status === 'cancelled' || task.status === 'completed')) {
    throw new CodeAgentEnqueueContextError('terminal', `当前任务状态 ${task.status} 不可继续`)
  }
}

export function resolveCodeAgentEnqueueContext(input: {
  task: QueryResult
  session: QueryResult
  userMessage: QueryResult
  taskId: string
  sessionId: string
  repo: string
}): { userMessageId: string } {
  assertAvailable([input.task, input.session, input.userMessage])
  const task = optionalTask(input.task.data)
  const session = sessionOf(input.session.data)
  const userMessage = userMessageOf(input.userMessage.data)
  const userMessageId = assertBindings({
    task,
    session,
    userMessage,
    taskId: input.taskId,
    sessionId: input.sessionId,
    repo: input.repo,
  })
  assertTaskActive(task)
  return { userMessageId }
}

type AgentEnqueueEnvelope = {
  enqueued: boolean
  replayed: boolean
  job: { id: string; status: JobStatus }
}

function singleton(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.length === 1 ? value[0] : null
}

function enqueueEnvelope(value: unknown): AgentEnqueueEnvelope | null {
  if (!isRecord(value) || typeof value.enqueued !== 'boolean'
    || typeof value.replayed !== 'boolean' || value.enqueued === value.replayed) return null
  const job = isRecord(value.job) ? value.job : null
  if (!job || !isJobIdentifier(job.id) || !isJobStatus(job.status)) return null
  return {
    enqueued: value.enqueued,
    replayed: value.replayed,
    job: { id: job.id, status: job.status },
  }
}

export function parseAgentEnqueueResult(
  data: unknown,
  error: unknown,
): { jobId: string; status: JobStatus; created: boolean } | null {
  if (error) return null
  const result = enqueueEnvelope(singleton(data))
  if (!result) return null
  return {
    jobId: result.job.id,
    status: result.job.status,
    created: result.enqueued && !result.replayed,
  }
}
