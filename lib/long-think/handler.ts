import { createAdminClient } from '@/lib/supabase/admin'
import { endpointAuthType, endpointOutputKind, getOwnedModelEndpoint, resolveModelEndpointKey } from '@/lib/model-endpoint-server'
import { isJsonValue, type JsonObject } from '@/lib/jobs/contracts'
import type { JobExecutionContext, JobHandler } from '@/lib/jobs/worker'
import type { SupabaseClient } from '@/lib/supabase/types'
import { checkpointJson, parseLongThinkCheckpoint, parseLongThinkJobInput, type LongThinkJobInput, type LongThinkRuntimeCheckpoint } from './contracts'
import { loadLongThinkSharedContext, runLongThinkCapabilities, type LongThinkSharedContext } from './capabilities'
import { LongThinkProviderError, longThinkCompletion, type LongThinkCompletion, type LongThinkMessage, type LongThinkProgressSnapshot } from './provider'

const SOLVER_SYSTEM = [
  '你是一个长期任务执行器。目标不是尽快结束，而是把用户的问题真正闭环。每次调用完成下一段最有价值的工作，然后输出一个可被下一次调用直接继承的状态快照。',
  '', '规则：',
  '1. 不要复述任务，不要写流程说明。',
  '2. 状态必须自包含：下一轮只拿到原问题和这份状态也能继续。',
  '3. 保留已验证结果、失败路线及失败原因、未解决缺口、下一步动作、必要公式/代码/数据/引用。',
  '4. 不要因为单轮停止、输出长度或上下文压力草率结束。',
  '5. 只有关键缺口全部关闭时 done 才能为 true。',
  '6. 如果已经有候选答案，优先审查最脆弱部分。',
  '7. 联网已经可用。需要最新资料、文献、事实核验或外部证据时，把检索词放进 web_queries。看到搜索结果后，如需阅读全文，把 URL 放进 fetch_urls。禁止凭记忆假装已经联网。',
  '8. MyChat 的共享长期记忆和相关历史对话会随请求提供。需要新增、更新或删除真正长期有用的全局记忆时，把操作放进 memory_actions；一次性研究过程不要写入全局记忆。',
  '9. 只输出一个 JSON 对象，不要 Markdown 围栏。',
  '', '格式：',
  '{"done":false,"progress_summary":"","established":[],"failed_routes":[{"route":"","reason":""}],"unresolved":[],"next_actions":[],"working_material":"","candidate_answer":"","web_queries":[],"fetch_urls":[],"memory_actions":[]}',
  '', 'web_queries 示例：["Riemann zeta simple critical line zeros latest unconditional proportion"]。',
  'fetch_urls 示例：["https://example.com/paper"]。',
  'memory_actions 示例：[{"name":"remember","arguments":{"content":"用户长期研究某问题"}}]。',
  '工具结果会写入 _capability_results，下一轮必须读取并使用。',
].join('\n')

const VERIFIER_SYSTEM = [
  '你是长期任务的独立闭环审查器。你的职责是阻止未完成的问题被过早判定为完成。基于原问题、当前状态和候选答案，逐项检查用户要求、逻辑缺口、关键计算或事实验证、未处理的 unresolved，以及仍能改变最终结论的下一步。',
  '如果关键事实仍需要联网核验，或者 state 中存在尚未消化的工具结果，不得判定完成。',
  '只输出 JSON：{"done":false,"gaps":[],"directive":"","final_answer":""}。存在任何影响结论的核心缺口时 done 必须为 false。',
].join('\n')

const REVIEWER_SYSTEM = [
  '你是最终审查器。你只在独立 verifier 已认为任务完成后出现。重新检查原问题、最终状态、候选答案和 verifier 结论，寻找遗漏、自相矛盾、错误计算、错误引用、没有覆盖的用户要求或仍会改变结论的缺口。',
  '只输出 JSON：{"done":false,"gaps":[],"directive":"","final_answer":""}。只有确认闭环时 done 才能为 true，并在 final_answer 给出可直接展示给用户的最终回复。',
].join('\n')

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

function solverUserMessage(problem: string, previous: string, round: number, sharedContext: string): string {
  return [
    '原始问题：', problem,
    '', 'MyChat 共享记忆 / 历史上下文：', sharedContext,
    '', '上一轮续接状态：', previous,
    '', '当前轮次：' + String(round),
    '', '继续工作。不要重新开始。优先处理 unresolved、审查器留下的缺口和 _capability_results。需要外部资料时主动请求联网工具。',
  ].join('\n')
}

function verifierUserMessage(problem: string, runtime: LongThinkRuntimeCheckpoint): string {
  return ['原始问题：', problem, '', '当前续接状态：', JSON.stringify(runtime.state), '', '候选答案：',
    runtime.candidateAnswer || '（尚未形成完整候选答案）', '', '已完成轮数：' + String(runtime.round)].join('\n')
}

function reviewerUserMessage(problem: string, runtime: LongThinkRuntimeCheckpoint, answer: string, verdict: JsonObject): string {
  return ['原始问题：', problem, '', '最终状态：', JSON.stringify(runtime.state), '', '候选答案：', answer,
    '', 'Verifier：', JSON.stringify(verdict)].join('\n')
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
