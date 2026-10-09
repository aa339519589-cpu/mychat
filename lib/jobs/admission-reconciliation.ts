import type { SupabaseClient } from '@/lib/supabase/types'
import { isRecord } from '@/lib/unknown-value'
import { BillingReconciliationMonitor } from './billing-reconciliation'

type RpcResult = { data: unknown; error: unknown }
export type AdmissionReconciliationTiming = {
  firstRpcMs: number | null
  reconciliationMs: number | null
  retryRpcMs: number | null
  reconciliationHealthy: boolean | null
}
const refreshing = new WeakMap<SupabaseClient, Promise<boolean>>()

export function isBillingReconciliationUnavailable(error: unknown): boolean {
  return isRecord(error) && error.code === '55000'
    && error.message === 'billing_reconciliation_unhealthy'
}

async function reconcile(client: SupabaseClient): Promise<boolean> {
  const pending = refreshing.get(client)
  if (pending) return pending
  const operation = new BillingReconciliationMonitor({
    createAdminClient: () => client,
    rpcTimeoutMs: 5_000,
  }).runOnce().then(snapshot => snapshot.healthy).catch(() => false)
  refreshing.set(client, operation)
  try { return await operation } finally {
    if (refreshing.get(client) === operation) refreshing.delete(client)
  }
}

/**
 * A sleeping runtime leaves an otherwise healthy snapshot older than the SQL
 * admission fence. Recover that snapshot once, without weakening the fence or
 * adding any read/refresh to successful warm admissions. The same command IDs
 * are replayed only after the authoritative scan says the balances reconcile.
 */
export async function withAdmissionReconciliation<T extends RpcResult>(
  client: SupabaseClient,
  invoke: () => PromiseLike<T>,
  onTiming?: (timing: AdmissionReconciliationTiming) => void,
): Promise<T> {
  const timing: AdmissionReconciliationTiming = {
    firstRpcMs: null, reconciliationMs: null, retryRpcMs: null, reconciliationHealthy: null,
  }
  async function measure<Result>(
    phase: 'firstRpcMs' | 'reconciliationMs' | 'retryRpcMs',
    operation: () => PromiseLike<Result>,
  ): Promise<Result> {
    const startedAt = performance.now()
    try { return await operation() } finally {
      timing[phase] = Math.max(0, Math.round(performance.now() - startedAt))
    }
  }
  try {
    const response = await measure('firstRpcMs', invoke)
    if (!isBillingReconciliationUnavailable(response.error)) return response
    timing.reconciliationHealthy = await measure('reconciliationMs', () => reconcile(client))
    if (!timing.reconciliationHealthy) return response
    return await measure('retryRpcMs', invoke)
  } finally {
    // Diagnostics must never turn an accepted durable command into a failed response.
    try { onTiming?.(timing) } catch { /* Keep the authority's original result. */ }
  }
}
