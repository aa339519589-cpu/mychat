import type { SupabaseClient } from '@/lib/supabase/types'
import { isRecord } from '@/lib/unknown-value'
import { BillingReconciliationMonitor } from './billing-reconciliation'

type RpcResult = { data: unknown; error: unknown }
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
): Promise<T> {
  const response = await invoke()
  if (!isBillingReconciliationUnavailable(response.error)) return response
  if (!await reconcile(client)) return response
  return invoke()
}
