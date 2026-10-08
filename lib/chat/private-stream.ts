import { randomUUID } from 'node:crypto'
import { buildModelContext } from '@/lib/llm/context'
import { buildSystem } from '@/lib/llm/system'
import { chatCompletionsUrl } from '@/lib/llm/openai'
import { runAgentLoop, type AgentLoopOpts } from '@/lib/llm/agent-loop'
import type { ChatEvent } from '@/lib/llm/events'
import type { ModelMessage } from '@/lib/llm/types'
import type { ChatRequestBody } from '@/lib/llm/chat-request'
import type { ChatModelSelection } from './model-selection'
import { activeTools, execTool, toOpenAITools, type ToolDef } from '@/lib/tools'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import type { JobRepository } from '@/lib/jobs/repository'
import { BILLING_PRICE_VERSION, platformModelCostMicros } from '@/lib/jobs/pricing'
import { weightedTokenUsage } from '@/lib/quota'
import type { TokenUsage } from '@/lib/token-usage'
import { isRecord } from '@/lib/unknown-value'

type PrivateLease = { jobId: string; workerId: string; leaseVersion: number; attempt: number }
type Options = {
  request: Request
  body: ChatRequestBody & { conversationId: string }
  selection: ChatModelSelection
  lease: PrivateLease
  usingBalance: boolean
  tokenLimit: number
}
type Dependencies = { repository: Pick<JobRepository, 'renew' | 'finalize'>; runLoop: typeof runAgentLoop; renewMs: number }
type Terminal = 'completed' | 'failed' | 'cancelled'
const encoder = new TextEncoder()
const MAX_OUTPUT_TOKENS = 4096

function privateEvent(event: ChatEvent): { kind: string; payload: object } | null {
  if ('text' in event) return { kind: 'text.delta', payload: { text: event.text } }
  if ('thinking' in event) return { kind: 'thinking.delta', payload: { thinking: event.thinking } }
  if ('reasoningSummary' in event) return { kind: 'reasoning.summary.delta', payload: { reasoningSummary: event.reasoningSummary } }
  if ('search' in event) return { kind: 'tool.search', payload: { search: event.search } }
  return null
}

function contextCost(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total + 16 + message.content.length
    if (!Array.isArray(message.content)) return total + 16
    return total + 16 + message.content.reduce((count, part: unknown) => count
      + (isRecord(part) && typeof part.text === 'string' ? part.text.length : 8192), 0)
  }, 0)
}

/** Content and tool results are request-local. The repository receives metadata only. */
class PrivateStreamSession {
  private readonly abort = new AbortController()
  private readonly signal: AbortSignal
  private sequence = 0
  private closed = false
  private text = ''
  private thinking = ''
  private reasoningSummary = ''
  private rawTokens = 0
  private fallbackInputTokens = 0
  private tokenUsage: TokenUsage | undefined
  private renewOperation: Promise<void> | null = null

  constructor(private readonly options: Options, private readonly dependencies: Dependencies,
    private readonly controller: ReadableStreamDefaultController<Uint8Array>) {
    this.signal = AbortSignal.any([this.abort.signal, options.request.signal, AbortSignal.timeout(300_000)])
  }

  private send(kind: string, payload: object): void {
    if (this.closed || this.signal.aborted) return
    this.controller.enqueue(encoder.encode(`data: ${JSON.stringify({ schemaVersion: 1,
      jobId: this.options.body.conversationId, seq: ++this.sequence, kind, payload })}\n\n`))
  }

  private emit(event: ChatEvent): void {
    if ('text' in event) this.text += event.text
    if ('thinking' in event) this.thinking += event.thinking
    if ('reasoningSummary' in event) this.reasoningSummary += event.reasoningSummary
    if (this.text.length + this.thinking.length + this.reasoningSummary.length > 1_000_000) {
      this.abort.abort(new Error('Private output limit'))
      return
    }
    const item = privateEvent(event)
    if (item) this.send(item.kind, item.payload)
  }

  private async renew(): Promise<void> {
    try {
      const result = await this.dependencies.repository.renew({ ...this.options.lease, leaseSeconds: 30 })
      if (result.state !== 'renewed' || result.cancelRequested) this.abort.abort(new Error('Private lease lost'))
    } catch { this.abort.abort(new Error('Private lease unavailable')) }
  }

  private startHeartbeat(): ReturnType<typeof setInterval> {
    return setInterval(() => {
      if (!this.renewOperation) this.renewOperation = this.renew().finally(() => { this.renewOperation = null })
    }, this.dependencies.renewMs)
  }

  private checkBudget(messages: ModelMessage[]): void {
    if (this.options.tokenLimit - this.rawTokens - contextCost(messages) < MAX_OUTPUT_TOKENS) {
      throw new Error('Private token budget exhausted')
    }
  }

  private async executeTool(tools: ToolDef[], name: string, input: unknown, searchMode: 'web' | 'off'): Promise<string> {
    this.signal.throwIfAborted()
    this.send('tool.started', { toolName: name })
    const outcome = await execTool(tools, name, input, { supabase: null, userId: null, searchMode, signal: this.signal })
    if (outcome.event && 'search' in outcome.event) this.emit(outcome.event as ChatEvent)
    this.send('tool.completed', { toolName: name })
    return outcome.result
  }

  private loopOptions(): AgentLoopOpts {
    const { selection, body, lease } = this.options
    const searchMode = body.searchMode === 'web' ? 'web' : 'off'
    const tools = activeTools({ loggedIn: false, searchMode, memoryEnabled: false })
    const messages: ModelMessage[] = [{ role: 'system', content: buildSystem(undefined, {
      searchMode, memoryEnabled: false, sensitiveMemoryEnabled: false, renderRules: body.renderEnabled === true, renderProfile: body.renderProfile,
      modelId: selection.model, tierLabel: selection.platformTierLabel,
    }) }, ...buildModelContext(body.messages, selection.capability)]
    this.fallbackInputTokens = contextCost(messages)
    this.checkBudget(messages)
    return { url: chatCompletionsUrl(selection.capability.provider.baseUrl), apiKey: selection.apiKey,
      model: selection.model, adapter: selection.capability.provider.adapter, thinking: selection.thinking,
      reasoningEffort: selection.reasoningEffort as import('@/lib/llm/provider-adapters').ReasoningEffort | null,
      messages, tools: toOpenAITools(tools), emit: event => this.emit(event), maxRounds: 8,
      onUsage: value => {
        this.rawTokens = value
        if (value > this.options.tokenLimit) throw new Error('Private token budget exceeded')
      },
      onCheckpoint: context => this.checkBudget(context),
      executeTool: (name, input) => this.executeTool(tools, name, input, searchMode),
      turnOptions: { signal: this.signal, timeoutMs: 120_000, authType: selection.authType,
        maxOutputTokens: MAX_OUTPUT_TOKENS, idempotencyNamespace: `private:${lease.jobId}`, logTiming: false },
    }
  }

  private async settle(status: Terminal): Promise<void> {
    const { selection, lease, usingBalance, tokenLimit } = this.options
    const outputChars = this.text.length + this.thinking.length + this.reasoningSummary.length
    const usageEstimated = this.rawTokens === 0 && outputChars > 0
    if (usageEstimated) this.rawTokens = Math.min(tokenLimit, this.fallbackInputTokens + Math.ceil(outputChars / 2))
    const weighted = weightedTokenUsage(this.rawTokens, selection.model, selection.thinking)
    const result = await this.dependencies.repository.finalize({ ...lease, status,
      result: { schemaVersion: 1, totalTokens: this.rawTokens },
      ...(status === 'failed' ? { error: { code: 'JOB_DEPENDENCY_UNAVAILABLE', message: 'Private generation failed',
        class: 'provider' as const, retryable: false, details: {} } } : {}),
      ledgerEntries: this.rawTokens > 0 ? [{ idempotencyKey: `${lease.jobId}:private-usage`, reason: 'platform_model_usage',
        direction: 'debit', weightedTokens: weighted, rawTokens: this.rawTokens, model: selection.model,
        provider: selection.capability.provider.id, costMicros: platformModelCostMicros(weighted), currency: 'USD',
        metadata: { thinking: selection.thinking, usingBalance, customEndpoint: false,
          priceVersion: BILLING_PRICE_VERSION, private: true, usageEstimated } }] : [],
    })
    if (!result.accepted && !result.replayed) throw new Error('Private settlement rejected')
  }

  private async finish(status: Terminal): Promise<void> {
    try {
      await this.settle(status)
      this.send('job.terminal', { status, result: { content: this.text,
        thinking: this.reasoningSummary ? `[[mychat:reasoning-summary:v1]]\n${this.reasoningSummary}` : this.thinking,
        tokenUsage: this.tokenUsage },
        ...(status === 'failed' ? { errorCode: 'JOB_DEPENDENCY_UNAVAILABLE' } : {}) })
    } catch {
      // An expired single-attempt lease releases the hold after a process/database failure.
      this.send('job.terminal', { status: 'failed', errorCode: 'JOB_DEPENDENCY_UNAVAILABLE' })
    }
    if (!this.closed) { this.closed = true; this.controller.close() }
    this.text = ''; this.thinking = ''; this.reasoningSummary = ''
  }

  async run(): Promise<void> {
    const heartbeat = this.startHeartbeat()
    let status: Terminal = 'completed'
    try {
      const result = await this.dependencies.runLoop(this.loopOptions())
      this.tokenUsage = result.tokenUsage
      this.signal.throwIfAborted()
      if (!this.text.trim()) throw new Error('Private empty output')
      this.send('model.output_completed', { tokenUsage: this.tokenUsage })
    } catch { status = this.signal.aborted ? 'cancelled' : 'failed' }
    finally {
      clearInterval(heartbeat)
      await this.renewOperation
      await this.finish(status)
    }
  }

  cancel(): void { this.closed = true; this.abort.abort(new Error('Private stream closed')) }
}

export function privateChatResponse(options: Options, overrides: Partial<Dependencies> = {}): Response {
  const dependencies = { repository: new SupabaseJobRepository(), runLoop: runAgentLoop, renewMs: 10_000, ...overrides }
  let session: PrivateStreamSession
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { session = new PrivateStreamSession(options, dependencies, controller); void session.run() },
    cancel() { session.cancel() },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Private-Usage-Job': options.lease.jobId } })
}

export function privateUsageIdentity() { return { jobId: randomUUID(), workerId: `private:${randomUUID()}` } }
