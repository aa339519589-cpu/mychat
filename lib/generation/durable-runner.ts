import type { SupabaseClient } from '@supabase/supabase-js'
import { log } from '@/lib/logger'
import {
  abortGeneration,
  appendText,
  appendThinking,
  createGeneration,
  discardGeneration,
  getAbortSignal,
  getGeneration,
  maybeGc,
  reconcileGeneration,
  setStatus,
} from './runtime'
import {
  claimGenerationLease,
  finalizeGenerationLease,
  persistGenerationProgress,
  renewGenerationLease,
} from './lease'
import { loadGenerationStatusFromDb } from './persist'
import {
  isTerminalGenerationStatus,
  type GenerationLease,
  type GenerationLeaseMutationResult,
  type GenerationStatus,
} from './types'
import {
  terminalSnapshotFromMutation,
  type TerminalConfirmation,
  type TerminalPlan,
} from './terminal'

const PERSIST_INTERVAL_MS = 1_000
const PERSIST_THROTTLE_MS = 800
const CANCELLATION_POLL_INTERVAL_MS = 1_000
const LEASE_RENEW_INTERVAL_MS = 12_000
const LEASE_DURATION_MS = 45_000
const LEASE_FAILURE = '生成任务执行租约已失效，请使用新的任务重试'

type ConfirmedMutation = Extract<GenerationLeaseMutationResult, { ok: true }>

export type DurableRunnerDependencies = {
  createGeneration: typeof createGeneration
  appendText: typeof appendText
  appendThinking: typeof appendThinking
  abortGeneration: typeof abortGeneration
  getAbortSignal: typeof getAbortSignal
  getGeneration: typeof getGeneration
  setStatus: typeof setStatus
  discardGeneration: typeof discardGeneration
  reconcileGeneration: typeof reconcileGeneration
  maybeGc: typeof maybeGc
  claimGenerationLease: typeof claimGenerationLease
  renewGenerationLease: typeof renewGenerationLease
  persistGenerationProgress: typeof persistGenerationProgress
  finalizeGenerationLease: typeof finalizeGenerationLease
  loadGenerationStatusFromDb: typeof loadGenerationStatusFromDb
  cancellationPollIntervalMs: number
}

export const DEFAULT_DURABLE_RUNNER_DEPENDENCIES: DurableRunnerDependencies = {
  createGeneration,
  appendText,
  appendThinking,
  abortGeneration,
  getAbortSignal,
  getGeneration,
  setStatus,
  discardGeneration,
  reconcileGeneration,
  maybeGc,
  claimGenerationLease,
  renewGenerationLease,
  persistGenerationProgress,
  finalizeGenerationLease,
  loadGenerationStatusFromDb,
  cancellationPollIntervalMs: CANCELLATION_POLL_INTERVAL_MS,
}

type RunnerInput = {
  supabase: SupabaseClient | null
  userId: string | null
  generationId: string
  conversationId?: string
  assistantMessageId: string
}

export type RunnerInitialization =
  | { response: Response; runner?: undefined }
  | { response?: undefined; runner: DurableGenerationRunner }

export async function initializeDurableGenerationRunner(
  input: RunnerInput,
  dependencies: DurableRunnerDependencies,
): Promise<RunnerInitialization> {
  const conversationId = input.conversationId || 'unknown'
  const local = dependencies.getGeneration(input.generationId)
  if (local && (
    local.record.userId !== input.userId
    || local.record.conversationId !== conversationId
    || local.record.assistantMessageId !== input.assistantMessageId
  )) {
    return {
      response: Response.json(
        { error: '生成任务标识冲突', generationId: input.generationId },
        { status: 409 },
      ),
    }
  }

  let lease: GenerationLease | null = null
  if (input.supabase && input.userId && input.conversationId) {
    const runnerId = crypto.randomUUID()
    const claim = await dependencies.claimGenerationLease({
      userId: input.userId,
      generationId: input.generationId,
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
      runnerId,
    })
    if (!claim.ok) {
      return {
        response: Response.json(
          { error: '生成任务协调服务暂时不可用，请稍后重试', generationId: input.generationId },
          { status: 503, headers: { 'Retry-After': '2' } },
        ),
      }
    }
    if (!claim.acquired) {
      const missing = claim.reason === 'invalid_parent' || claim.reason === 'not_found'
      return {
        response: Response.json({
          error: missing ? '会话或生成任务不存在' : '生成任务已由其他执行进程处理',
          generationId: input.generationId,
          status: claim.status,
          reason: claim.reason,
        }, { status: missing ? 404 : 409 }),
      }
    }
    lease = claim.lease
  }

  if (input.userId) {
    dependencies.createGeneration({
      id: input.generationId,
      userId: input.userId,
      conversationId,
      assistantMessageId: input.assistantMessageId,
      durability: input.supabase && input.userId && input.conversationId ? 'durable' : 'ephemeral',
    })
    dependencies.setStatus(input.generationId, 'running')
  }
  return { runner: new DurableGenerationRunner(input, lease, dependencies) }
}

export class DurableGenerationRunner {
  private readonly runnerAbort = new AbortController()
  private readonly sharedCancellationSignal: AbortSignal | undefined
  readonly signal: AbortSignal
  private leaseDeadlineMs: number
  private leaseLost = false
  private authoritativeStatus: GenerationStatus | null = null
  private latestMutation: ConfirmedMutation | null = null
  private lastPersistAt = 0
  private persistInFlight: Promise<void> | null = null
  private renewalInFlight: Promise<void> | null = null
  private cancellationCheck: Promise<boolean> | null = null
  private persistTimer: ReturnType<typeof setInterval> | null = null
  private cancellationTimer: ReturnType<typeof setInterval> | null = null
  private renewalTimer: ReturnType<typeof setInterval> | null = null
  private streamedContent = ''
  private streamedThinking = ''
  private streamedSequence = 0

  constructor(
    private readonly input: RunnerInput,
    private readonly lease: GenerationLease | null,
    private readonly dependencies: DurableRunnerDependencies,
  ) {
    this.sharedCancellationSignal = dependencies.getAbortSignal(input.generationId)
    this.signal = this.sharedCancellationSignal
      ? AbortSignal.any([this.sharedCancellationSignal, this.runnerAbort.signal])
      : this.runnerAbort.signal
    this.leaseDeadlineMs = lease ? Date.parse(lease.expiresAt) : Number.POSITIVE_INFINITY
  }

  appendText(delta: string) {
    this.streamedContent += delta
    this.streamedSequence += 1
    this.dependencies.appendText(this.input.generationId, delta)
  }

  appendThinking(delta: string) {
    this.streamedThinking += delta
    this.streamedSequence += 1
    this.dependencies.appendThinking(this.input.generationId, delta)
  }

  async start() {
    await this.persistProgress(true)
    if (!this.lease) return
    this.persistTimer = setInterval(() => { void this.persistProgress(false) }, PERSIST_INTERVAL_MS)
    this.cancellationTimer = setInterval(
      () => this.scheduleCancellationCheck(),
      this.dependencies.cancellationPollIntervalMs,
    )
    this.renewalTimer = setInterval(() => this.scheduleRenewal(), LEASE_RENEW_INTERVAL_MS)
  }

  assertAuthority() {
    if (this.lease && Date.now() >= this.leaseDeadlineMs) this.stopFencedRunner('generation_lease_expired')
    if (this.signal.aborted) throw this.signal.reason
  }

  async observeRemoteTerminal() {
    if (!this.input.supabase || !this.input.userId || this.authoritativeStatus) {
      return Boolean(this.authoritativeStatus)
    }
    let result: Awaited<ReturnType<typeof loadGenerationStatusFromDb>>
    try {
      result = await this.dependencies.loadGenerationStatusFromDb(
        this.input.generationId,
        this.input.userId,
      )
    } catch {
      this.stopFencedRunner('generation_coordination_unavailable')
      return false
    }
    if (result.kind !== 'found') {
      this.stopFencedRunner(result.kind === 'not_found'
        ? 'generation_coordination_not_found'
        : `generation_coordination_${result.reason}`)
      return false
    }
    const status = result.value
    if (!isTerminalGenerationStatus(status)) return false
    this.authoritativeStatus = status
    if (status === 'cancelled') {
      this.dependencies.abortGeneration(this.input.generationId, this.input.userId)
    }
    if (!this.runnerAbort.signal.aborted) {
      this.runnerAbort.abort(new DOMException(`generation_${status}`, 'AbortError'))
    }
    return true
  }

  resolveTerminal(fallback: TerminalPlan): TerminalPlan {
    if (this.authoritativeStatus && isTerminalGenerationStatus(this.authoritativeStatus)) {
      return { status: this.authoritativeStatus }
    }
    if (this.sharedCancellationSignal?.aborted) return { status: 'cancelled' }
    if (this.leaseLost) return { status: 'failed', error: LEASE_FAILURE }
    return fallback
  }

  async finalize(plan: TerminalPlan): Promise<TerminalConfirmation> {
    await this.stop()
    const { supabase, userId, generationId } = this.input
    if (this.lease && supabase && userId) {
      if (!this.leaseLost && !this.authoritativeStatus) await this.renewLease()
      const entry = this.dependencies.getGeneration(generationId)
      if (entry) {
        const result = await this.dependencies.finalizeGenerationLease({
          userId,
          generationId,
          runnerId: this.lease.runnerId,
          leaseVersion: this.lease.version,
          status: plan.status,
          content: entry.record.content,
          thinking: entry.record.thinking,
          sequence: entry.record.sequence,
          error: plan.error,
          media: plan.status === 'completed' ? plan.media ?? [] : [],
        })
        if (result.ok) this.latestMutation = result
      }
      if (this.latestMutation && isTerminalGenerationStatus(this.latestMutation.status)) {
        const terminal = terminalSnapshotFromMutation(this.latestMutation)
        if (!terminal) {
          this.dependencies.discardGeneration(generationId, userId)
          return { confirmed: false }
        }
        this.dependencies.reconcileGeneration(generationId, userId, this.latestMutation)
        this.dependencies.maybeGc(generationId)
        return {
          confirmed: true,
          ...terminal,
        }
      }
      this.dependencies.discardGeneration(generationId, userId)
      return { confirmed: false }
    }

    const terminalMedia = plan.status === 'completed' ? plan.media ?? [] : []
    const beforeTerminal = this.dependencies.getGeneration(generationId)
    if (beforeTerminal) beforeTerminal.record.media = terminalMedia
    this.dependencies.setStatus(generationId, plan.status, plan.error)
    const entry = this.dependencies.getGeneration(generationId)
    this.dependencies.maybeGc(generationId)
    return {
      confirmed: true,
      status: plan.status,
      content: entry?.record.content ?? this.streamedContent,
      thinking: entry?.record.thinking ?? this.streamedThinking,
      sequence: entry?.record.sequence ?? this.streamedSequence,
      error: entry?.record.error ?? plan.error ?? null,
      media: terminalMedia,
    }
  }

  private stopFencedRunner(reason: string) {
    if (this.leaseLost) return
    this.leaseLost = true
    log.warn('generation', 'runner fenced out', { generationId: this.input.generationId, reason })
    if (!this.runnerAbort.signal.aborted) {
      this.runnerAbort.abort(new DOMException(reason, 'AbortError'))
    }
  }

  private async persistProgress(force: boolean) {
    if (!this.input.supabase || !this.input.userId || !this.lease || this.leaseLost) return
    if (this.persistInFlight) {
      if (!force) return
      await this.persistInFlight
    }
    const entry = this.dependencies.getGeneration(this.input.generationId)
    if (!entry) return
    const now = Date.now()
    if (!force && now - this.lastPersistAt < PERSIST_THROTTLE_MS) return
    this.lastPersistAt = now
    const snapshot = { ...entry.record }
    const write = (async () => {
      const result = await this.dependencies.persistGenerationProgress({
        userId: this.input.userId!,
        generationId: this.input.generationId,
        runnerId: this.lease!.runnerId,
        leaseVersion: this.lease!.version,
        content: snapshot.content,
        thinking: snapshot.thinking,
        sequence: snapshot.sequence,
      })
      if (!result.ok) return
      this.latestMutation = result
      if (!result.accepted) {
        if (isTerminalGenerationStatus(result.status)) this.authoritativeStatus = result.status
        this.stopFencedRunner('generation_lease_lost')
      }
    })()
    this.persistInFlight = write
    try { await write } finally {
      if (this.persistInFlight === write) this.persistInFlight = null
    }
  }

  private async renewLease() {
    if (!this.lease || !this.input.supabase || this.leaseLost || this.authoritativeStatus) return
    const renewal = await this.dependencies.renewGenerationLease({
      userId: this.input.userId!,
      generationId: this.input.generationId,
      runnerId: this.lease.runnerId,
      leaseVersion: this.lease.version,
    })
    if (renewal === 'renewed') this.leaseDeadlineMs = Date.now() + LEASE_DURATION_MS
    else this.stopFencedRunner(`generation_lease_${renewal}`)
  }

  private scheduleRenewal() {
    if (this.renewalInFlight) return
    const renewal = this.renewLease()
    this.renewalInFlight = renewal
    void renewal.finally(() => {
      if (this.renewalInFlight === renewal) this.renewalInFlight = null
    })
  }

  private scheduleCancellationCheck() {
    if (this.cancellationCheck) return
    const check = this.observeRemoteTerminal()
    this.cancellationCheck = check
    void check.finally(() => {
      if (this.cancellationCheck === check) this.cancellationCheck = null
    })
  }

  private async stop() {
    if (this.persistTimer) clearInterval(this.persistTimer)
    if (this.cancellationTimer) clearInterval(this.cancellationTimer)
    if (this.renewalTimer) clearInterval(this.renewalTimer)
    if (this.cancellationCheck) await this.cancellationCheck
    if (this.renewalInFlight) await this.renewalInFlight
    if (this.persistInFlight) await this.persistInFlight
  }
}
