import type { SupabaseClient } from '@/lib/supabase/types'
import { createAdminClient } from '@/lib/supabase/admin'

const RPC_TIMEOUT_MS = 2_000

export type BillingReconciliationMetricsV1 = {
  schemaVersion: 1
  generation: number
  generatedAt: string
  healthy: boolean
  releaseReady: boolean
  releaseBlockers: number
  totalMismatches: number
  newJobsWithoutReservations: number
  activeLegacyJobs: number
  terminalHeldReservations: number
  quoteMismatches: number
  movementEquationMismatches: number
  ledgerReceiptMismatches: number
  profileBalanceMismatches: number
  catalogActivationMismatches: number
  heldBalanceTokens: number
}

type Dependencies = {
  createAdminClient: () => SupabaseClient | null
  rpcTimeoutMs: number
}
type RpcResponse = { data: unknown; error: unknown }
type RpcRequest = PromiseLike<RpcResponse> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResponse>
}

export class BillingReconciliationMetricsUnavailable extends Error {
  constructor() {
    super('Billing reconciliation metrics are unavailable')
    this.name = 'BillingReconciliationMetricsUnavailable'
  }
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

export function parseBillingReconciliationMetrics(
  value: unknown,
): BillingReconciliationMetricsV1 {
  const normalized = Array.isArray(value) ? value[0] : value
  const row = normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : null
  const numeric = row ? {
    generation: count(row.generation),
    totalMismatches: count(row.totalMismatches),
    releaseBlockers: count(row.releaseBlockers),
    newJobsWithoutReservations: count(row.newJobsWithoutReservations),
    activeLegacyJobs: count(row.activeLegacyJobs),
    terminalHeldReservations: count(row.terminalHeldReservations),
    quoteMismatches: count(row.quoteMismatches),
    movementEquationMismatches: count(row.movementEquationMismatches),
    ledgerReceiptMismatches: count(row.ledgerReceiptMismatches),
    profileBalanceMismatches: count(row.profileBalanceMismatches),
    catalogActivationMismatches: count(row.catalogActivationMismatches),
    heldBalanceTokens: count(row.heldBalanceTokens),
  } : null
  if (!row || row.schemaVersion !== 1 || typeof row.generatedAt !== 'string'
    || !Number.isFinite(Date.parse(row.generatedAt)) || typeof row.healthy !== 'boolean'
    || typeof row.releaseReady !== 'boolean'
    || !numeric || Object.values(numeric).some(item => item === null)
    || ['principalId', 'jobId', 'ledgerEntryId', 'sku'].some(key => key in row)) {
    throw new BillingReconciliationMetricsUnavailable()
  }
  const componentTotal = Number(numeric.newJobsWithoutReservations)
    + Number(numeric.terminalHeldReservations)
    + Number(numeric.quoteMismatches)
    + Number(numeric.movementEquationMismatches)
    + Number(numeric.ledgerReceiptMismatches)
    + Number(numeric.profileBalanceMismatches)
    + Number(numeric.catalogActivationMismatches)
  if (Number(numeric.totalMismatches) !== componentTotal
    || Number(numeric.releaseBlockers) !== componentTotal + Number(numeric.activeLegacyJobs)
    || row.healthy !== (componentTotal === 0)
    || row.releaseReady !== (Number(numeric.releaseBlockers) === 0)) {
    throw new BillingReconciliationMetricsUnavailable()
  }
  return {
    schemaVersion: 1,
    generation: Number(numeric.generation),
    generatedAt: row.generatedAt,
    healthy: row.healthy,
    releaseReady: row.releaseReady,
    releaseBlockers: Number(numeric.releaseBlockers),
    totalMismatches: componentTotal,
    newJobsWithoutReservations: Number(numeric.newJobsWithoutReservations),
    activeLegacyJobs: Number(numeric.activeLegacyJobs),
    terminalHeldReservations: Number(numeric.terminalHeldReservations),
    quoteMismatches: Number(numeric.quoteMismatches),
    movementEquationMismatches: Number(numeric.movementEquationMismatches),
    ledgerReceiptMismatches: Number(numeric.ledgerReceiptMismatches),
    profileBalanceMismatches: Number(numeric.profileBalanceMismatches),
    catalogActivationMismatches: Number(numeric.catalogActivationMismatches),
    heldBalanceTokens: Number(numeric.heldBalanceTokens),
  }
}

export async function readBillingReconciliationMetrics(
  dependencyOverrides: Partial<Dependencies> = {},
): Promise<BillingReconciliationMetricsV1> {
  const dependencies: Dependencies = {
    createAdminClient,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    ...dependencyOverrides,
  }
  const client = dependencies.createAdminClient()
  if (!client || !Number.isFinite(dependencies.rpcTimeoutMs) || dependencies.rpcTimeoutMs <= 0) {
    throw new BillingReconciliationMetricsUnavailable()
  }
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const raw = client.rpc('read_billing_reconciliation_v1') as unknown as RpcRequest
    const operation = typeof raw.abortSignal === 'function'
      ? raw.abortSignal(controller.signal)
      : raw
    const response = await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => {
            controller.abort()
            reject(new BillingReconciliationMetricsUnavailable())
          },
          dependencies.rpcTimeoutMs,
        )
      }),
    ])
    if (response.error) throw new BillingReconciliationMetricsUnavailable()
    return parseBillingReconciliationMetrics(response.data)
  } catch (error) {
    if (error instanceof BillingReconciliationMetricsUnavailable) throw error
    throw new BillingReconciliationMetricsUnavailable()
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function exportBillingReconciliationMetrics(
  metrics: BillingReconciliationMetricsV1,
  now: number | Date = Date.now(),
): string {
  const nowMs = now instanceof Date ? now.getTime() : now
  const values: Array<[string, string, number]> = [
    ['snapshot_age_seconds', 'Age of the latest authoritative billing reconciliation.', Math.max(0, (nowMs - Date.parse(metrics.generatedAt)) / 1_000)],
    ['snapshot_generation', 'Monotonic billing reconciliation snapshot generation.', metrics.generation],
    ['healthy', 'Whether every billing reconciliation invariant currently holds.', metrics.healthy ? 1 : 0],
    ['release_ready', 'Whether reconciliation and every pre-cutover Job permit release.', metrics.releaseReady ? 1 : 0],
    ['release_blockers', 'Billing reconciliation and legacy-drain release blockers.', metrics.releaseBlockers],
    ['mismatches_total', 'Total release-blocking billing reconciliation mismatches.', metrics.totalMismatches],
    ['new_jobs_without_reservations', 'Billing v2 Jobs missing an atomic reservation.', metrics.newJobsWithoutReservations],
    ['active_legacy_jobs', 'Pre-cutover Jobs that must drain before release.', metrics.activeLegacyJobs],
    ['terminal_held_reservations', 'Terminal Jobs whose admission hold was not settled.', metrics.terminalHeldReservations],
    ['quote_mismatches', 'Reservation quote payload or hash mismatches.', metrics.quoteMismatches],
    ['movement_equation_mismatches', 'Balance holds that do not equal debit minus credit plus release.', metrics.movementEquationMismatches],
    ['ledger_receipt_mismatches', 'Ledger entries missing a matching debit or credit receipt.', metrics.ledgerReceiptMismatches],
    ['profile_balance_mismatches', 'Profile balances that diverge from anchor plus immutable journal.', metrics.profileBalanceMismatches],
    ['catalog_activation_mismatches', 'Price SKUs without a forward-only active version.', metrics.catalogActivationMismatches],
    ['held_balance_tokens', 'Tokens currently held for admitted balance-funded Jobs.', metrics.heldBalanceTokens],
  ]
  return `${values.flatMap(([suffix, help, value]) => {
    const name = `mychat_authoritative_billing_${suffix}`
    return [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`]
  }).join('\n')}\n`
}
