import type { SupabaseClient } from '@/lib/supabase/types'
import { createAdminClient } from '@/lib/supabase/admin'
import { log } from '@/lib/logger'
import { awaitAbortableRequest, type AbortableRequest } from './abortable-request'
import { defaultJobSleep } from './worker-config'

const DEFAULT_INTERVAL_MS = 5 * 60_000
const DEFAULT_RPC_TIMEOUT_MS = 10_000

type Options = {
  intervalMs?: number
  rpcTimeoutMs?: number
  createAdminClient?: () => SupabaseClient | null
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

function interval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10_000 || value > 24 * 60 * 60_000) {
    throw new TypeError('Invalid billing reconciliation interval')
  }
  return value
}

function rpcTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 60_000) {
    throw new TypeError('Invalid billing reconciliation RPC timeout')
  }
  return value
}

function validSnapshot(value: unknown): value is Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value
  return Boolean(row && typeof row === 'object' && !Array.isArray(row)
    && (row as Record<string, unknown>).schemaVersion === 1
    && typeof (row as Record<string, unknown>).healthy === 'boolean'
    && typeof (row as Record<string, unknown>).releaseReady === 'boolean'
    && Number.isSafeInteger((row as Record<string, unknown>).totalMismatches)
    && Number((row as Record<string, unknown>).totalMismatches) >= 0
    && Number.isSafeInteger((row as Record<string, unknown>).releaseBlockers)
    && Number((row as Record<string, unknown>).releaseBlockers) >= 0)
}

export class BillingReconciliationMonitor {
  private readonly intervalMs: number
  private readonly rpcTimeoutMs: number
  private readonly createClient: () => SupabaseClient | null
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>

  constructor(options: Options = {}) {
    this.intervalMs = interval(options.intervalMs ?? DEFAULT_INTERVAL_MS)
    this.rpcTimeoutMs = rpcTimeout(options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
    this.createClient = options.createAdminClient ?? createAdminClient
    this.sleep = options.sleep ?? defaultJobSleep
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const snapshot = await this.runOnce(signal)
        if (!snapshot.releaseReady) {
          log.error('billing', 'Billing reconciliation detected release blockers', {
            releaseBlockers: snapshot.releaseBlockers,
          })
        }
      } catch (error) {
        log.error('billing', 'Billing reconciliation refresh failed', {
          name: error instanceof Error ? error.name : 'unknown',
        })
      }
      try { await this.sleep(this.intervalMs, signal) } catch {
        if (!signal.aborted) throw new Error('Billing reconciliation wait failed')
      }
    }
  }

  async runOnce(signal?: AbortSignal): Promise<{
    healthy: boolean
    releaseReady: boolean
    totalMismatches: number
    releaseBlockers: number
  }> {
    const client = this.createClient()
    if (!client) throw new Error('Billing reconciliation database is unavailable')
    const request = client.rpc('refresh_billing_reconciliation_v1') as unknown as AbortableRequest<{
      data: unknown
      error: unknown
    }>
    const { data, error } = await awaitAbortableRequest(request, {
      timeoutMs: this.rpcTimeoutMs,
      timeoutMessage: 'Billing reconciliation refresh timed out',
      signal,
    })
    const normalized = Array.isArray(data) ? data[0] : data
    if (error || !validSnapshot(normalized)) {
      throw new Error('Billing reconciliation returned malformed data')
    }
    return {
      healthy: normalized.healthy as boolean,
      releaseReady: normalized.releaseReady as boolean,
      totalMismatches: Number(normalized.totalMismatches),
      releaseBlockers: Number(normalized.releaseBlockers),
    }
  }
}
