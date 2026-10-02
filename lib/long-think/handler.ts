import { createAdminClient } from '@/lib/supabase/admin'
import { endpointAuthType, endpointOutputKind, getOwnedModelEndpoint, resolveModelEndpointKey } from '@/lib/model-endpoint-server'
import { isJsonValue, type JsonObject } from '@/lib/jobs/contracts'
import type { JobExecutionContext, JobHandler } from '@/lib/jobs/worker'
import type { SupabaseClient } from '@/lib/supabase/types'
import { checkpointJson, parseLongThinkCheckpoint, parseLongThinkJobInput, type LongThinkJobInput, type LongThinkRuntimeCheckpoint } from './contracts'
import { loadLongThinkSharedContext, runLongThinkCapabilities, type LongThinkSharedContext } from './capabilities'
import { LongThinkProviderError, longThinkCompletion, type LongThinkCompletion, type LongThinkMessage, type LongThinkProgressSnapshot } from './provider'
import { REVIEWER_SYSTEM, SOLVER_SYSTEM, VERIFIER_SYSTEM, reviewerUserMessage, solverUserMessage, verifierUserMessage } from './prompts'

type OwnedEndpoint = NonNullable<Awaited<ReturnType<typeof getOwnedModelEndpoint>>>
type HandlerResult = Awaited<ReturnType<JobHandler>>
type SolveRoundResult = { state: JsonObject; capabilitiesRan: boolean }

function asJsonObject(value: unknown): JsonObject | null {
  return isJsonValue(value) && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null
}

function parseJsonCandidate(value: string): JsonObject | null {
  try { return asJsonObject(JSON.parse(value)) } catch { return null }
}

function scanJsonObject(text: string, start: number): JsonObject | null {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === '{') depth++
    if (char !== '}') continue
    depth--
    if (depth === 0) return parseJsonCandidate(text.slice(start, index + 1))
  }
  return null
}

function extractJsonObject(text: string): JsonObject | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const direct = parseJsonCandidate(trimmed)
  if (direct) return direct
  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== '{') continue
    const parsed = scanJsonObject(trimmed, start)
    if (parsed) return parsed
  }
  return null
}

function mergeTokenTotal(current: number | null, next: number | null): number | null {
  return current === null || next === null ? null : current + next
}

function account(runtime: LongThinkRuntimeCheckpoint, completion: LongThinkCompletion): void {
  runtime.usage.apiCalls += 1
  runtime.usage.inputTokens = mergeTokenTotal(runtime.usage.inputTokens, completion.usage.inputTokens)
  runtime.usage.outputTokens = mergeTokenTotal(runtime.usage.outputTokens, completion.usage.outputTokens)
}

function visibleText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

function visibleStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).map(item => (typeof item === 'string' ? item : JSON.stringify(item)).slice(0, 2_000))
}

function progress(runtime: LongThinkRuntimeCheckpoint, phase: string): JsonObject {
  const state = runtime.state
  return {
    feature: 'long-think', state: 'thinking', phase, round: runtime.round,
    apiCalls: runtime.usage.apiCalls, inputTokens: runtime.usage.inputTokens,
    outputTokens: runtime.usage.outputTokens, verifierRuns: runtime.verifierRuns,
    reviewerRuns: runtime.reviewerRuns,
    progressSummary: visibleText(state.progress_summary, 8_000),
    established: visibleStrings(state.established),
    unresolved: visibleStrings(state.unresolved),
    nextActions: visibleStrings(state.next_actions),
    workingMaterial: visibleText(state.working_material, 20_000),
    providerReasoning: runtime.lastReasoning.slice(-40_000),
    providerStreamText: runtime.lastStreamText.slice(-40_000),
    capabilityActivity: visibleStrings(state._capability_activity),
  }
}

async function persist(context: JobExecutionContext, runtime: LongThinkRuntimeCheckpoint, phase: string): Promise<void> {
  await context.checkpoint({
    phase, checkpoint: checkpointJson(runtime), progress: progress(runtime, phase),
    resumable: true, status: 'running',
  })
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    const aborted = () => done(signal.reason)
    function done(error?: unknown) {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      if (error !== undefined) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function doneOf(state: JsonObject): boolean { return state.done === true }
function directiveOf(value: JsonObject): string { return typeof value.directive === 'string' ? value.directive : '' }
function candidateOf(state: JsonObject, fallback: string): string {
  return typeof state.candidate_answer === 'string' ? state.candidate_answer : fallback
}
function finalAnswerOf(value: JsonObject, fallback: string): string {
  return typeof value.final_answer === 'string' && value.final_answer.trim() ? value.final_answer : fallback
}
function gapsOf(value: JsonObject): string[] {
  if (!Array.isArray(value.gaps)) return []
  return value.gaps.map(gap => typeof gap === 'string' ? gap : JSON.stringify(gap)).slice(0, 256)
}

function continuationCheckpoint(runtime: LongThinkRuntimeCheckpoint): JsonObject {
  return checkpointJson({
    ...runtime,
    state: { ...runtime.state, done: false },
    lastReasoning: '',
    lastStreamText: '',
  })
}

class LongThinkSession {
  private consecutiveErrors = 0
  private lastLiveCheckpointAt = 0
  private shared: LongThinkSharedContext = { memoryEnabled: true, text: '共享上下文正在载入。' }

  constructor(
    private readonly context: JobExecutionContext,
    private readonly input: LongThinkJobInput,
    private readonly endpoint: OwnedEndpoint,
    private readonly apiKey: string,
    private readonly runtime: LongThinkRuntimeCheckpoint,
    private readonly client: SupabaseClient,
    private readonly userId: string,
  ) {}

  private async initialize(): Promise<void> {
    try {
      this.shared = await loadLongThinkSharedContext(this.client, this.userId, this.input.problem, this.context.signal)
    } catch {
      this.shared = { memoryEnabled: true, text: '共享记忆读取暂时失败；任务继续执行。' }
    }
  }

  private async publishLive(snapshot: LongThinkProgressSnapshot): Promise<void> {
    if (snapshot.reasoning.trim()) this.runtime.lastReasoning = snapshot.reasoning.slice(-120_000)
    if (snapshot.text.trim()) this.runtime.lastStreamText = snapshot.text.slice(-120_000)
    if (!snapshot.reasoning.trim() && !snapshot.text.trim()) return
    const now = Date.now()
    if (now - this.lastLiveCheckpointAt < 3_000) return
    this.lastLiveCheckpointAt = now
    await persist(this.context, this.runtime, 'model-stream')
  }

  private async complete(messages: readonly LongThinkMessage[], maxTokens = this.input.maxTokens): Promise<LongThinkCompletion> {
    const result = await longThinkCompletion({
      baseUrl: this.endpoint.base_url, apiKey: this.apiKey,
      authType: endpointAuthType(this.endpoint.auth_type), model: this.endpoint.model,
      messages, maxTokens, signal: this.context.signal,
      onProgress: snapshot => this.publishLive(snapshot),
    })
    account(this.runtime, result)
    if (result.reasoning.trim()) this.runtime.lastReasoning = result.reasoning.slice(-120_000)
    if (result.text.trim()) this.runtime.lastStreamText = result.text.slice(-120_000)
    return result
  }

  private async requestJson(messages: readonly LongThinkMessage[], maxTokens = this.input.maxTokens): Promise<JsonObject> {
    const first = await this.complete(messages, maxTokens)
    const parsed = extractJsonObject(first.text)
    if (parsed) return parsed
    this.runtime.formatFailures += 1
    const repaired = await this.complete([
      { role: 'system', content: '把下面的模型工作结果转换成一个合法、完整、可续接的 JSON 对象。保留所有有用成果、工具请求和未解决缺口。只输出 JSON，不要继续扩展答案。' },
      { role: 'user', content: (first.text || first.reasoning).slice(0, 500_000) },
    ], Math.min(maxTokens, 65_536))
    const repairedState = extractJsonObject(repaired.text)
    if (repairedState) return repairedState
    throw new LongThinkProviderError('模型连续返回无法解析的状态 JSON', { retryable: true })
  }

  private async solveRound(): Promise<SolveRoundResult> {
    const previous = Object.keys(this.runtime.state).length
      ? JSON.stringify(this.runtime.state)
      : '（第一轮，没有旧状态）'
    this.runtime.lastReasoning = ''
    this.runtime.lastStreamText = ''
    await persist(this.context, this.runtime, 'model-call')
    const state = await this.requestJson([
      { role: 'system', content: SOLVER_SYSTEM },
      { role: 'user', content: solverUserMessage(this.input.problem, previous, this.runtime.round + 1, this.shared.text) },
    ])
    this.runtime.round += 1
    this.runtime.candidateAnswer = candidateOf(state, this.runtime.candidateAnswer)
    await persist(this.context, { ...this.runtime, state }, 'solving')

    const capability = await runLongThinkCapabilities(
      state, this.client, this.userId, this.shared.memoryEnabled, this.context.signal,
    )
    this.runtime.state = capability.state
    await persist(this.context, this.runtime, capability.ran ? 'tools' : 'solving')
    return { state: this.runtime.state, capabilitiesRan: capability.ran }
  }

  private shouldVerify(state: JsonObject): boolean {
    if (this.runtime.round < this.input.minRounds) return false
    return doneOf(state) || this.runtime.round % this.input.verifyEvery === 0
  }

  private async verify(): Promise<JsonObject> {
    await persist(this.context, this.runtime, 'verifying')
    const verdict = await this.requestJson([
      { role: 'system', content: VERIFIER_SYSTEM },
      { role: 'user', content: verifierUserMessage(this.input.problem, this.runtime) },
    ], Math.min(this.input.maxTokens, 32_768))
    this.runtime.verifierRuns += 1
    return verdict
  }

  private async review(answer: string, verdict: JsonObject): Promise<JsonObject> {
    await persist(this.context, this.runtime, 'final-reviewing')
    const review = await this.requestJson([
      { role: 'system', content: REVIEWER_SYSTEM },
      { role: 'user', content: reviewerUserMessage(this.input.problem, this.runtime, answer, verdict) },
    ], Math.min(this.input.maxTokens, 32_768))
    this.runtime.reviewerRuns += 1
    return review
  }

  private async recordGap(key: '_closure_review' | '_final_review', value: JsonObject, phase: string): Promise<void> {
    this.runtime.state = {
      ...this.runtime.state,
      [key]: { gaps: gapsOf(value), directive: directiveOf(value) },
    }
    await persist(this.context, this.runtime, phase)
  }

  private async tryClosure(): Promise<string | null> {
    const verdict = await this.verify()
    if (!doneOf(verdict)) {
      await this.recordGap('_closure_review', verdict, 'closure-review')
      return null
    }
    const verifiedAnswer = finalAnswerOf(verdict, this.runtime.candidateAnswer)
    const review = await this.review(verifiedAnswer, verdict)
    if (!doneOf(review)) {
      this.runtime.candidateAnswer = verifiedAnswer
      await this.recordGap('_final_review', review, 'final-review')
      return null
    }
    const finalAnswer = finalAnswerOf(review, verifiedAnswer)
    if (finalAnswer.trim()) return finalAnswer
    await this.recordGap('_final_review', { gaps: ['最终答案为空'], directive: '形成可直接交付给用户的最终答案' }, 'final-review')
    return null
  }

  private completed(finalAnswer: string): HandlerResult {
    return {
      status: 'completed',
      result: {
        feature: 'long-think', finalAnswer, round: this.runtime.round,
        apiCalls: this.runtime.usage.apiCalls, inputTokens: this.runtime.usage.inputTokens,
        outputTokens: this.runtime.usage.outputTokens, verifierRuns: this.runtime.verifierRuns,
        reviewerRuns: this.runtime.reviewerRuns,
        endpointId: this.input.endpointId,
        continuationCheckpoint: continuationCheckpoint(this.runtime),
      },
    }
  }

  private failure(error: LongThinkProviderError): HandlerResult {
    return {
      status: 'failed',
      error: {
        code: 'LONG_THINK_PROVIDER_REJECTED', message: error.message, retryable: false,
        class: 'provider', details: error.status === null ? {} : { status: error.status },
      },
    }
  }

  private async recover(error: unknown): Promise<HandlerResult | null> {
    if (this.context.signal.aborted) throw this.context.signal.reason
    const providerError = error instanceof LongThinkProviderError
      ? error : new LongThinkProviderError('长期任务模型调用失败', { retryable: true, cause: error })
    if (!providerError.retryable) return this.failure(providerError)
    this.runtime.transientErrors += 1
    this.consecutiveErrors += 1
    await persist(this.context, this.runtime, 'retrying')
    const delay = Math.min(300_000, 2_000 * (2 ** Math.min(this.consecutiveErrors - 1, 8)))
    await sleep(delay, this.context.signal)
    return null
  }

  async run(): Promise<HandlerResult> {
    await this.initialize()
    while (true) {
      this.context.assertAuthority()
      try {
        const round = await this.solveRound()
        this.consecutiveErrors = 0
        if (round.capabilitiesRan || !this.shouldVerify(round.state)) continue
        const finalAnswer = await this.tryClosure()
        if (finalAnswer === null) continue
        return this.completed(finalAnswer)
      } catch (error) {
        const failure = await this.recover(error)
        if (failure) return failure
      }
    }
  }
}

function seededRuntime(input: LongThinkJobInput, checkpoint: JsonObject | null | undefined): LongThinkRuntimeCheckpoint {
  const runtime = parseLongThinkCheckpoint(checkpoint ?? input.seedCheckpoint)
  if (!checkpoint && input.seedCheckpoint) {
    runtime.state = {
      ...runtime.state,
      done: false,
      _continuation: {
        fromJobId: input.continuedFrom ?? '',
        instruction: input.problem,
      },
    }
    runtime.lastReasoning = ''
    runtime.lastStreamText = ''
  }
  return runtime
}

export const handleLongThinkJob: JobHandler = async context => {
  const input = parseLongThinkJobInput(context.job.input)
  const admin = createAdminClient()
  if (!admin) return {
    status: 'failed',
    error: { code: 'LONG_THINK_STORAGE_UNAVAILABLE', message: '长期任务存储未就绪', retryable: true, class: 'internal', details: {} },
  }
  const endpoint = await getOwnedModelEndpoint(admin, context.job.principal.id, input.endpointId)
  if (!endpoint || endpointOutputKind(endpoint.output_kind) !== 'chat') return {
    status: 'failed',
    error: { code: 'LONG_THINK_ENDPOINT_NOT_FOUND', message: '长期任务使用的模型端点不存在', retryable: false, class: 'user', details: {} },
  }
  let apiKey: string
  try { apiKey = resolveModelEndpointKey(endpoint, context.job.principal.id) }
  catch {
    return {
      status: 'failed',
      error: { code: 'LONG_THINK_ENDPOINT_KEY', message: '模型端点凭据无法读取，请重新连接该端点', retryable: false, class: 'user', details: {} },
    }
  }
  const runtime = seededRuntime(input, context.job.checkpoint?.data)
  return new LongThinkSession(context, input, endpoint, apiKey, runtime, admin, context.job.principal.id).run()
}
