import { isJobName, JOB_LIMITS } from './contracts'

const MESSAGE_TYPE = 'mychat.job.wake.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ProcessJobWakeMessage = {
  type: typeof MESSAGE_TYPE
  queue: string
  jobId: string
  publishedAt: number
}

export function parseProcessJobWakeMessage(value: unknown): ProcessJobWakeMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Partial<ProcessJobWakeMessage>
  if (item.type !== MESSAGE_TYPE
    || !isJobName(item.queue, JOB_LIMITS.queueLength)
    || typeof item.jobId !== 'string'
    || !UUID.test(item.jobId)
    || !Number.isSafeInteger(item.publishedAt)
    || Number(item.publishedAt) <= 0) return null
  return item as ProcessJobWakeMessage
}

/**
 * Best-effort local notification after the database transaction has admitted
 * the Job. The queue itself remains authoritative and bounded polling remains
 * the cross-host/lost-message fallback.
 */
export function publishProcessJobWake(queue: string, jobId: string): void {
  if (process.env.MYCHAT_LOCAL_LIVE_RELAY !== '1' || !process.connected || !process.send) return
  const message = parseProcessJobWakeMessage({
    type: MESSAGE_TYPE,
    queue,
    jobId,
    publishedAt: Date.now(),
  })
  if (!message) return
  try { process.send(message, () => undefined) } catch { /* The poll fallback remains active. */ }
}
