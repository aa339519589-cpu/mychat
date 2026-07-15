import { createHash } from 'node:crypto'
import { isJobIdentifier, isJsonValue, type JobRecord } from './contracts'
import { JobRuntimeError } from './errors'
import type { JobAccounting } from './repository'

export type JobBudgetSnapshot = {
  wallTimeMs: number
  rawTokens: number
  weightedTokens: number
  costMicros: number
  sandboxTimeMs: number
  toolCalls: number
}

export type JobBudgetControl = {
  snapshot: () => JobBudgetSnapshot
  assertWithinLimits: () => void
  consumeToolCall: (count?: number) => void
  reportSandboxTime: (milliseconds: number) => void
  remainingSandboxTimeMs: () => number | null
}

type AbortExecution = (error: JobRuntimeError) => void

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', `Invalid job accounting ${name}`)
  }
  return Number(value)
}

function costMicros(entry: JobAccounting): number {
  if (entry.costMicros !== undefined) return nonNegativeInteger(entry.costMicros, 'costMicros')
  const estimate = entry.costEstimate ?? 0
  if (!Number.isFinite(estimate) || estimate < 0 || estimate > 1_000_000) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job accounting costEstimate')
  }
  const micros = Math.round(estimate * 1_000_000)
  if (!Number.isSafeInteger(micros)) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job accounting costEstimate')
  }
  return micros
}

function normalizedAccounting(entry: JobAccounting): JobAccounting {
  if (!isJobIdentifier(entry.idempotencyKey) || entry.idempotencyKey.length > 300
    || typeof entry.reason !== 'string' || entry.reason.length < 1 || entry.reason.length > 200
    || (entry.direction !== undefined && entry.direction !== 'debit' && entry.direction !== 'credit')
    || (entry.model !== undefined && (typeof entry.model !== 'string' || entry.model.length > 256))
    || (entry.provider !== undefined && (typeof entry.provider !== 'string' || entry.provider.length > 256))
    || (entry.currency !== undefined && !/^[A-Z]{3}$/.test(entry.currency))) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job accounting entry')
  }
  const rawTokens = nonNegativeInteger(entry.rawTokens ?? 0, 'rawTokens')
  const weightedTokens = nonNegativeInteger(entry.weightedTokens ?? 0, 'weightedTokens')
  const micros = costMicros(entry)
  const metadata = entry.metadata ?? {}
  if (!isJsonValue(metadata) || Array.isArray(metadata) || metadata === null) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job accounting metadata')
  }
  return {
    idempotencyKey: entry.idempotencyKey,
    reason: entry.reason,
    direction: entry.direction ?? 'debit',
    weightedTokens,
    rawTokens,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.provider ? { provider: entry.provider } : {}),
    costEstimate: micros / 1_000_000,
    currency: entry.currency ?? 'USD',
    metadata,
  }
}

function comparable(entry: JobAccounting): string {
  return JSON.stringify({
    reason: entry.reason,
    direction: entry.direction ?? 'debit',
    model: entry.model ?? null,
    provider: entry.provider ?? null,
    currency: entry.currency ?? 'USD',
    metadata: entry.metadata ?? {},
  })
}

type AccountingTotals = {
  rawTokens: number
  weightedTokens: number
  costMicros: number
}

type ResourceTotals = {
  wallTimeMs: number
  sandboxTimeMs: number
  toolCalls: number
}

type PendingAccounting = {
  entries: JobAccounting[]
  reportTargets: Map<string, JobAccounting>
  resourceTarget: ResourceTotals | null
}

function totals(entry: JobAccounting | undefined): AccountingTotals {
  return {
    rawTokens: nonNegativeInteger(entry?.rawTokens ?? 0, 'rawTokens'),
    weightedTokens: nonNegativeInteger(entry?.weightedTokens ?? 0, 'weightedTokens'),
    costMicros: entry ? costMicros(entry) : 0,
  }
}

function immutableKey(job: JobRecord, logicalKey: string, identity: object): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ logicalKey, attempt: job.attempt, ...identity }))
    .digest('hex')
  return `${job.id}:attempt:${job.attempt}:${digest}`
}

function accountingDelta(
  job: JobRecord,
  logicalKey: string,
  current: JobAccounting,
  acknowledged: JobAccounting | undefined,
): JobAccounting | null {
  const currentTotals = totals(current)
  const acknowledgedTotals = totals(acknowledged)
  const rawTokens = currentTotals.rawTokens - acknowledgedTotals.rawTokens
  const weightedTokens = currentTotals.weightedTokens - acknowledgedTotals.weightedTokens
  const deltaCostMicros = currentTotals.costMicros - acknowledgedTotals.costMicros
  if (rawTokens < 0 || weightedTokens < 0 || deltaCostMicros < 0) {
    throw new JobRuntimeError('JOB_INTERNAL', 'Acknowledged job accounting exceeds the current report')
  }
  if (rawTokens === 0 && weightedTokens === 0 && deltaCostMicros === 0) return null
  const cumulative = {
    rawTokens: currentTotals.rawTokens,
    weightedTokens: currentTotals.weightedTokens,
    costMicros: currentTotals.costMicros,
  }
  return {
    idempotencyKey: immutableKey(job, logicalKey, cumulative),
    reason: current.reason,
    direction: current.direction ?? 'debit',
    rawTokens,
    weightedTokens,
    ...(current.model ? { model: current.model } : {}),
    ...(current.provider ? { provider: current.provider } : {}),
    costEstimate: deltaCostMicros / 1_000_000,
    currency: current.currency ?? 'USD',
    metadata: {
      ...(current.metadata ?? {}),
      attempt: job.attempt,
      accountingKey: logicalKey,
      costMicros: deltaCostMicros,
      cumulativeRawTokens: cumulative.rawTokens,
      cumulativeWeightedTokens: cumulative.weightedTokens,
      cumulativeCostMicros: cumulative.costMicros,
    },
  }
}

export class JobBudgetController implements JobBudgetControl {
  private readonly job: JobRecord
  private readonly now: () => number
  private readonly startedAt: number
  private readonly abortExecution: AbortExecution
  private readonly reports = new Map<string, JobAccounting>()
  private readonly acknowledgedReports = new Map<string, JobAccounting>()
  private acknowledgedResources: ResourceTotals = { wallTimeMs: 0, sandboxTimeMs: 0, toolCalls: 0 }
  private resourceAcknowledged = false
  private pendingAccounting: PendingAccounting | null = null
  private toolCalls = 0
  private sandboxTimeMs = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(job: JobRecord, now: () => number, abortExecution: AbortExecution) {
    this.job = job
    this.now = now
    this.startedAt = now()
    this.abortExecution = abortExecution
  }

  armWallTimer(): void {
    const limit = this.job.budget.wallTimeMs
    if (typeof limit !== 'number') return
    const remaining = limit - this.job.usage.wallTimeMs
    if (remaining <= 0) {
      this.exceeded('wallTimeMs', limit, this.job.usage.wallTimeMs)
    }
    this.timer = setTimeout(() => {
      const used = this.snapshot().wallTimeMs
      this.abortExecution(this.error('wallTimeMs', limit, used))
    }, remaining)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  snapshot(): JobBudgetSnapshot {
    let rawTokens = this.job.usage.rawTokens
    let weightedTokens = this.job.usage.weightedTokens
    let reportCostMicros = 0
    for (const report of this.reports.values()) {
      rawTokens += nonNegativeInteger(report.rawTokens ?? 0, 'rawTokens')
      weightedTokens += nonNegativeInteger(report.weightedTokens ?? 0, 'weightedTokens')
      reportCostMicros += costMicros(report)
    }
    return {
      wallTimeMs: this.job.usage.wallTimeMs + Math.max(0, Math.round(this.now() - this.startedAt)),
      rawTokens,
      weightedTokens,
      costMicros: this.job.usage.costMicros + reportCostMicros,
      sandboxTimeMs: this.job.usage.sandboxTimeMs + this.sandboxTimeMs,
      toolCalls: this.job.usage.toolCalls + this.toolCalls,
    }
  }

  assertWithinLimits(): void {
    const snapshot = this.snapshot()
    this.check('wallTimeMs', this.job.budget.wallTimeMs, snapshot.wallTimeMs)
    this.check('tokenLimit', this.job.budget.tokenLimit, snapshot.rawTokens)
    this.check('costMicros', this.job.budget.costMicros, snapshot.costMicros)
    this.check('sandboxTimeMs', this.job.budget.sandboxTimeMs, snapshot.sandboxTimeMs)
    this.check('toolCallLimit', this.job.budget.toolCallLimit, snapshot.toolCalls)
  }

  consumeToolCall(count = 1): void {
    this.toolCalls += nonNegativeInteger(count, 'toolCalls')
    this.assertWithinLimits()
  }

  reportSandboxTime(milliseconds: number): void {
    this.sandboxTimeMs += nonNegativeInteger(Math.round(milliseconds), 'sandboxTimeMs')
    this.assertWithinLimits()
  }

  remainingSandboxTimeMs(): number | null {
    const limit = this.job.budget.sandboxTimeMs
    return typeof limit === 'number'
      ? Math.max(0, limit - this.snapshot().sandboxTimeMs)
      : null
  }

  reportAccounting(entry: JobAccounting): void {
    const normalized = normalizedAccounting(entry)
    const key = entry.idempotencyKey
    const existing = this.reports.get(key)
    if (existing && (comparable(existing) !== comparable(normalized)
      || Number(normalized.rawTokens ?? 0) < Number(existing.rawTokens ?? 0)
      || Number(normalized.weightedTokens ?? 0) < Number(existing.weightedTokens ?? 0)
      || Number(normalized.costEstimate ?? 0) < Number(existing.costEstimate ?? 0))) {
      throw new JobRuntimeError('JOB_INVALID_INPUT', 'Job accounting report regressed or changed identity')
    }
    if (!existing && this.reports.size >= 31) {
      throw new JobRuntimeError('JOB_INVALID_INPUT', 'Too many job accounting entries')
    }
    this.reports.set(key, normalized)
    this.assertWithinLimits()
  }

  pendingLedgerEntries(forceResource = false): readonly JobAccounting[] {
    if (this.pendingAccounting) return this.pendingAccounting.entries
    const entries: JobAccounting[] = []
    const reportTargets = new Map<string, JobAccounting>()
    for (const [logicalKey, report] of this.reports) {
      const delta = accountingDelta(this.job, logicalKey, report, this.acknowledgedReports.get(logicalKey))
      if (!delta) continue
      entries.push(delta)
      reportTargets.set(logicalKey, report)
    }
    const elapsed = Math.max(0, Math.round(this.now() - this.startedAt))
    const resourceTarget: ResourceTotals = {
      wallTimeMs: elapsed,
      sandboxTimeMs: this.sandboxTimeMs,
      toolCalls: this.toolCalls,
    }
    const resourceDelta: ResourceTotals = {
      wallTimeMs: resourceTarget.wallTimeMs - this.acknowledgedResources.wallTimeMs,
      sandboxTimeMs: resourceTarget.sandboxTimeMs - this.acknowledgedResources.sandboxTimeMs,
      toolCalls: resourceTarget.toolCalls - this.acknowledgedResources.toolCalls,
    }
    if (Object.values(resourceDelta).some(value => value < 0)) {
      throw new JobRuntimeError('JOB_INTERNAL', 'Acknowledged resources exceed current job usage')
    }
    const includeResource = forceResource && !this.resourceAcknowledged
      || Object.values(resourceDelta).some(value => value > 0)
    if (includeResource) {
      entries.push({
        idempotencyKey: immutableKey(this.job, 'resource-usage', resourceTarget),
        reason: 'job_resource_usage',
        direction: 'debit',
        weightedTokens: 0,
        rawTokens: 0,
        costEstimate: 0,
        currency: 'USD',
        metadata: {
          wallTimeMs: resourceDelta.wallTimeMs,
          sandboxTimeMs: resourceDelta.sandboxTimeMs,
          toolCalls: resourceDelta.toolCalls,
          attempt: this.job.attempt,
          accountingKey: 'resource-usage',
          costMicros: 0,
          cumulativeWallTimeMs: resourceTarget.wallTimeMs,
          cumulativeSandboxTimeMs: resourceTarget.sandboxTimeMs,
          cumulativeToolCalls: resourceTarget.toolCalls,
        },
      })
    }
    if (entries.length === 0) return entries
    this.pendingAccounting = {
      entries,
      reportTargets,
      resourceTarget: includeResource ? resourceTarget : null,
    }
    return entries
  }

  acknowledgeLedgerEntries(entries: readonly JobAccounting[]): void {
    const pending = this.pendingAccounting
    if (!pending || entries !== pending.entries) {
      throw new JobRuntimeError('JOB_INTERNAL', 'Job accounting acknowledgment does not match the pending batch')
    }
    for (const [logicalKey, report] of pending.reportTargets) {
      this.acknowledgedReports.set(logicalKey, report)
    }
    if (pending.resourceTarget) {
      this.acknowledgedResources = pending.resourceTarget
      this.resourceAcknowledged = true
    }
    this.pendingAccounting = null
  }

  /** @deprecated Use pendingLedgerEntries and acknowledgeLedgerEntries. */
  ledgerEntries(): readonly JobAccounting[] {
    return this.pendingLedgerEntries(true)
  }

  private check(dimension: string, limit: number | undefined, used: number): void {
    if (typeof limit === 'number' && used > limit) this.exceeded(dimension, limit, used)
  }

  private error(dimension: string, limit: number, used: number): JobRuntimeError {
    return new JobRuntimeError('JOB_BUDGET_EXCEEDED', `Job ${dimension} budget was exceeded`, {
      class: 'policy',
      retryable: false,
      details: { dimension, limit, used },
    })
  }

  private exceeded(dimension: string, limit: number, used: number): never {
    const error = this.error(dimension, limit, used)
    this.abortExecution(error)
    throw error
  }
}
