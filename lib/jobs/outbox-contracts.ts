import type { JsonObject } from './contracts'

export const JOB_OUTBOX_TOPICS = [
  'assets.cleanup',
  'payloads.cleanup',
  'jobs.cancel_requested',
  'jobs.poison',
  'jobs.ready',
  'jobs.terminal',
] as const

export type JobOutboxTopic = typeof JOB_OUTBOX_TOPICS[number]

export type JobOutboxMessage = {
  id: string
  jobId: string
  principalId: string
  topic: JobOutboxTopic
  payload: JsonObject
  attempt: number
  maxAttempts: number
  lockVersion: number
  lockExpiresAt: string
  createdAt: string
}

export type JobOutboxClaim =
  | { acquired: true; message: JobOutboxMessage }
  | { acquired: false; message: null }

export interface JobOutboxRepository {
  claim(input: {
    workerId: string
    topics: readonly JobOutboxTopic[]
    lockSeconds: number
  }): Promise<JobOutboxClaim>
  renew(input: {
    outboxId: string
    workerId: string
    lockVersion: number
    lockSeconds: number
  }): Promise<void>
  publish(input: { outboxId: string; workerId: string; lockVersion: number }): Promise<void>
  fail(input: {
    outboxId: string
    workerId: string
    lockVersion: number
    errorCode: string
    retrySeconds: number
  }): Promise<void>
  cleanupAssets(input: { message: JobOutboxMessage; workerId: string }): Promise<number>
  cleanupPayload(input: { message: JobOutboxMessage; workerId: string }): Promise<boolean>
}
