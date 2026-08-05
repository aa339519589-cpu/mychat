import { isRecord } from '@/lib/unknown-value'

export type EnqueueTimeoutPolicy = {
  requestTimeoutMs: number
  reconcileTimeoutMs: number
  totalTimeoutMs: number
}

export const DEFAULT_ENQUEUE_TIMEOUT_POLICY: EnqueueTimeoutPolicy = {
  requestTimeoutMs: 15_000,
  reconcileTimeoutMs: 3_000,
  totalTimeoutMs: 30_000,
}

const REGENERATION_ENQUEUE_TIMEOUT_POLICY: EnqueueTimeoutPolicy = {
  requestTimeoutMs: 45_000,
  reconcileTimeoutMs: 10_000,
  totalTimeoutMs: 90_000,
}

export function enqueueTimeoutPolicy(body: unknown): EnqueueTimeoutPolicy {
  return isRecord(body) && isRecord(body.turn) && body.turn.schemaVersion === 2
    ? REGENERATION_ENQUEUE_TIMEOUT_POLICY
    : DEFAULT_ENQUEUE_TIMEOUT_POLICY
}
