import { isRecord } from '@/lib/unknown-value'
import type { JobStreamEnvelope } from '@/components/literary-chat/job-stream-client'
import { reduceCodeStreamEvent, type CodeStreamState } from './stream'

export function applyCodeJobEnvelope(
  state: CodeStreamState,
  envelope: JobStreamEnvelope,
): CodeStreamState {
  const { kind, payload } = envelope
  if (kind === 'job.retry_scheduled'
    || (kind === 'job.leased' && typeof payload.attempt === 'number' && payload.attempt > 1)) {
    return {
      ...state,
      steps: [],
      plan: [],
      fullText: '',
      hadError: false,
      streamDone: false,
      publishPending: false,
    }
  }
  if (kind === 'job.started' && typeof payload.taskId === 'string') {
    return reduceCodeStreamEvent(state, { data: { taskId: payload.taskId } })
  }
  if (kind === 'text.delta' && typeof payload.text === 'string') {
    return reduceCodeStreamEvent(state, { data: { text: payload.text } })
  }
  if (kind === 'agent.step' && isRecord(payload.step)) {
    return reduceCodeStreamEvent(state, { data: { step: payload.step } })
  }
  if (kind === 'agent.plan' && isRecord(payload.plan)) {
    return reduceCodeStreamEvent(state, { data: { plan: payload.plan } })
  }
  if (kind !== 'job.terminal') return state

  const status = typeof payload.status === 'string' ? payload.status : 'failed'
  const result = isRecord(payload.result) ? payload.result : null
  const terminalContent = typeof result?.content === 'string' ? result.content : ''
  if (status === 'completed') {
    return {
      ...state,
      fullText: state.fullText || terminalContent,
      streamDone: true,
    }
  }
  const fallback = status === 'cancelled'
    ? '已停止。'
    : `任务执行失败${typeof payload.errorCode === 'string' ? `：${payload.errorCode}` : '，请稍后重试。'}`
  return {
    ...state,
    fullText: state.fullText || terminalContent || fallback,
    hadError: status !== 'cancelled',
    streamDone: true,
  }
}
