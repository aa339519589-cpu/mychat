/** Closed production queue set shared by readiness and authoritative metrics. */
export const REQUIRED_JOB_WORKER_QUEUES = [
  'chat',
  'media',
  'title',
  'agent',
  'outbox',
] as const

export type RequiredJobWorkerQueue = typeof REQUIRED_JOB_WORKER_QUEUES[number]
