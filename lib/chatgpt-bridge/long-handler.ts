import { JobRuntimeError } from '@/lib/jobs/errors'
import { isJsonValue, type JsonObject, type JsonValue } from '@/lib/jobs/contracts'
import type { JobExecutionContext, JobHandler } from '@/lib/jobs/worker'
import type { LongThinkCompletion, LongThinkMessage } from '@/lib/long-think/provider'
import { ChatGptBridgeError, chatGptSubscriptionCompletion } from './completion'

const SOLVER_SYSTEM = [
  '你是 MyChat 的长期任务执行器，运行在用户自己的 ChatGPT 订阅会话中。目标不是尽快结束，而是持续推进直到问题真正闭环。',
  '每一轮只做下一段最有价值的工作，然后输出一个可由下一轮直接继承的状态。',
  '不要复述任务，不要写流程说明。保留已验证结果、失败路线及原因、未解决缺口、下一步动作、必要计算、代码、证据和引用。',
  '不要因为单轮回复结束、输出长度、上下文压力或已经有候选答案而草率停止。只有关键缺口全部关闭时 done 才能为 true。',
  '如果当前 ChatGPT 界面提供联网、工具或其他能力，而任务需要它们，直接使用。',
  '只输出一个 JSON 对象，不要 Markdown 围栏。',
  '格式：{"done":false,"progress_summary":"","established":[],"failed_routes":[{"route":"","reason":""}],"unresolved":[],"next_actions":[],"working_material":"","candidate_answer":""}',
].join('\n')

const VERIFIER_SYSTEM = [
  '你是独立闭环审查器。逐项检查原问题、当前状态和候选答案。寻找遗漏、逻辑缺口、错误计算、事实未核验、未处理的 unresolved，以及仍能改变最终结论的下一步。',
  '存在任何影响结论的核心缺口时 done 必须为 false。',
  '只输出 JSON：{"done":false,"gaps":[],"directive":"","final_answer":""}。',
].join('\n')

const REVIEWER_SYSTEM = [
  '你是最终审查器，只在 verifier 已认为任务完成后出现。重新独立检查全部要求、状态、候选答案和 verifier 结论。',
  '发现遗漏、自相矛盾、计算错误、事实错误、没有覆盖的要求或仍会改变结论的缺口时 done 必须为 false。',
  '只输出 JSON：{"done":false,"gaps":[],"directive":"","final_answer":""}。只有真正闭环时 done 才能为 true，并给出可直接展示给用户的 final_answer。',
].join('\n')

type Input = {
  problem: string
  maxTokens: number
  minRounds: number
  verifyEvery: number
}

type Runtime = {
  round: number
  apiCalls: number
  verifierRuns: number
  reviewerRuns: number
  formatFailures: number
  state: JsonObject
  candidateAnswer: string
  lastText: string
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function jsonObject(value: unknown): JsonObject | null {
  return isJsonValue(value) && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
  if (value === undefined) return fallback
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null
}

function parseInput(value: unknown): Input | null {
  const row = object(value)
  if (!row) return null
  const problem = typeof row.problem === 'string' ? row.problem.trim() : ''
  const maxTokens = integer(row.maxTokens, 32_768, 512, 262_144)
  const minRounds = integer(row.minRounds, 4, 1, 100_000)
  const verifyEvery = integer(row.verifyEvery, 6, 1, 10_000)
  if (!problem || problem.length > 1_000_000 || maxTokens === null || minRounds === null || verifyEvery === null) return null
  return { problem, maxTokens, minRounds, verifyEvery }
}

function blankRuntime(): Runtime {
  return {
    round: 0,
    apiCalls: 0,
    verifierRuns: 0,
    reviewerRuns: 0,
    formatFailures: 0,
    state: {},
    candidateAnswer: '',
    lastText: '',
  }
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback
}

function runtimeFrom(value: JsonObject | null | undefined): Runtime {
  if (!value) return blankRuntime()
  return {
    round: nonNegativeInteger(value.round),
    apiCalls: nonNegativeInteger(value.apiCalls),
    verifierRuns: nonNegativeInteger(value.verifierRuns),
    reviewerRuns: nonNegativeInteger(value.reviewerRuns),
    formatFailures: nonNegativeInteger(value.formatFailures),
    state: jsonObject(value.state) ?? {},
    candidateAnswer: typeof value.candidateAnswer === 'string' ? value.candidateAnswer : '',
    lastText: typeof value.lastText === 'string' ? value.lastText : '',
  }
}

function runtimeJson(runtime: Runtime): JsonObject {
  return {
    round: runtime.round,
    apiCalls: runtime.apiCalls,
    verifierRuns: runtime.verifierRuns,
    reviewerRuns: runtime.reviewerRuns,
    formatFailures: runtime.formatFailures,
    state: runtime.state,
    candidateAnswer: runtime.candidateAnswer,
    lastText: runtime.lastText.slice(-120_000),
  }
}

function visibleText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.slice(0, maximum) : ''
}

function visibleStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 12).map(item => (typeof item === 'string' ? item : JSON.stringify(item)).slice(0, 2_000))
}

function progress(runtime: Runtime, phase: string): JsonObject {
  return {
    feature: 'chatgpt-subscription-long-think',
    state: 'thinking',
    phase,
    round: runtime.round,
    apiCalls: runtime.apiCalls,
    verifierRuns: runtime.verifierRuns,
    reviewerRuns: runtime.reviewerRuns,
    progressSummary: visibleText(runtime.state.progress_summary, 8_000),
    established: visibleStrings(runtime.state.established),
    unresolved: visibleStrings(runtime.state.unresolved),
    nextActions: visibleStrings(runtime.state.next_actions),
    workingMaterial: visibleText(runtime.state.working_material, 20_000),
    providerStreamText: runtime.lastText.slice(-40_000),
  }
}

async function persist(context: JobExecutionContext, runtime: Runtime, phase: string): Promise<void> {
  await context.checkpoint({
    phase,
    checkpoint: runtimeJson(runtime),
    progress: progress(runtime, phase),
    resumable: true,
    status: 'running',
  })
}

function parseJsonCandidate(value: string): JsonObject | null {
  try { return jsonObject(JSON.parse(value)) } catch { return null }
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

function doneOf(value: JsonObject): boolean { return value.done === true }
function candidateOf(value: JsonObject, fallback: string): string {
  return typeof value.candidate_answer === 'string' ? value.candidate_answer : fallback
}
function directiveOf(value: JsonObject): string {
  return typeof value.directive === 'string' ? value.directive : ''
}
function finalAnswerOf(value: JsonObject, fallback: string): string {
  return typeof value.final_answer === 'string' && value.final_answer.trim() ? value.final_answer : fallback
}
function gapsOf(value: JsonObject): JsonValue[] {
  return Array.isArray(value.gaps) ? value.gaps.slice(0, 256) : []
}

function solverMessage(problem: string, runtime: Runtime): string {
  const previous = Object.keys(runtime.state).length
    ? JSON.stringify(runtime.state).slice(0, 500_000)
    : '（第一轮，没有旧状态）'
  return [
    '原始问题：', problem,
    '', '上一轮续接状态：', previous,
    '', `当前轮次：${runtime.round + 1}`,
    '', '继续工作，不要重新开始。优先处理 unresolved 和审查器留下的缺口。',
  ].join('\n')
}

function verifierMessage(problem: string, runtime: Runtime): string {
  return [
    '原始问题：', problem,
    '', '当前续接状态：', JSON.stringify(runtime.state).slice(0, 500_000),
    '', '候选答案：', runtime.candidateAnswer.slice(0, 300_000) || '（尚未形成完整候选答案）',
    '', `已完成轮数：${runtime.round}`,
  ].join('\n')
}

function reviewerMessage(problem: string, runtime: Runtime, verdict: JsonObject): string {
  return [
    '原始问题：', problem,
    '', '最终状态：', JSON.stringify(runtime.state).slice(0, 500_000),
    '', '候选答案：', runtime.candidateAnswer.slice(0, 300_000),
    '', 'Verifier：', JSON.stringify(verdict).slice(0, 100_000),
  ].join('\n')
}

class Session {
  constructor(
    private readonly context: JobExecutionContext,
    private readonly input: Input,
    private readonly runtime: Runtime,
  ) {}

  private async complete(purpose: string, messages: readonly LongThinkMessage[], maxTokens = this.input.maxTokens): Promise<LongThinkCompletion> {
    await persist(this.context, this.runtime, `waiting-${purpose}`)
    try {
      const result = await chatGptSubscriptionCompletion({
        parentJobId: this.context.job.id,
        principalId: this.context.job.principal.id,
        authClass: this.context.job.principal.authClass,
        purpose,
        messages,
        maxTokens,
        signal: this.context.signal,
      })
      this.runtime.apiCalls += 1
      this.runtime.lastText = (result.text || result.reasoning).slice(-120_000)
      return result
    } catch (error) {
      if (error instanceof ChatGptBridgeError) {
        throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', error.message, { retryable: true, cause: error })
      }
      throw error
    }
  }

  private async requestJson(purpose: string, messages: readonly LongThinkMessage[], maxTokens = this.input.maxTokens): Promise<JsonObject> {
    const first = await this.complete(purpose, messages, maxTokens)
    const parsed = extractJsonObject(first.text)
    if (parsed) return parsed
    this.runtime.formatFailures += 1
    const repaired = await this.complete(`repair-${purpose}`, [
      { role: 'system', content: '把下面的模型工作结果转换成一个合法、完整、可续接的 JSON 对象。保留所有有用成果和未解决缺口。只输出 JSON，不继续扩展答案。' },
      { role: 'user', content: (first.text || first.reasoning).slice(0, 500_000) },
    ], Math.min(maxTokens, 65_536))
    const repairedState = extractJsonObject(repaired.text)
    if (repairedState) return repairedState
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'ChatGPT 连续返回无法解析的状态 JSON', { retryable: true })
  }

  private async solve(): Promise<JsonObject> {
    const nextRound = this.runtime.round + 1
    const state = await this.requestJson(`solve-${nextRound}`, [
      { role: 'system', content: SOLVER_SYSTEM },
      { role: 'user', content: solverMessage(this.input.problem, this.runtime) },
    ])
    this.runtime.round = nextRound
    this.runtime.state = state
    this.runtime.candidateAnswer = candidateOf(state, this.runtime.candidateAnswer)
    await persist(this.context, this.runtime, 'solving')
    return state
  }

  private shouldVerify(state: JsonObject): boolean {
    if (this.runtime.round < this.input.minRounds) return false
    return doneOf(state) || this.runtime.round % this.input.verifyEvery === 0
  }

  private async verify(): Promise<JsonObject> {
    const verdict = await this.requestJson(`verify-${this.runtime.round}`, [
      { role: 'system', content: VERIFIER_SYSTEM },
      { role: 'user', content: verifierMessage(this.input.problem, this.runtime) },
    ], Math.min(this.input.maxTokens, 65_536))
    this.runtime.verifierRuns += 1
    await persist(this.context, this.runtime, 'verifying')
    return verdict
  }

  private async review(verdict: JsonObject): Promise<JsonObject> {
    const review = await this.requestJson(`review-${this.runtime.round}`, [
      { role: 'system', content: REVIEWER_SYSTEM },
      { role: 'user', content: reviewerMessage(this.input.problem, this.runtime, verdict) },
    ], Math.min(this.input.maxTokens, 65_536))
    this.runtime.reviewerRuns += 1
    await persist(this.context, this.runtime, 'reviewing')
    return review
  }

  private reopen(verdict: JsonObject, source: string): void {
    this.runtime.state = {
      ...this.runtime.state,
      done: false,
      _review_source: source,
      _review_gaps: gapsOf(verdict),
      _review_directive: directiveOf(verdict),
    }
  }

  async run(): Promise<Awaited<ReturnType<JobHandler>>> {
    while (!this.context.signal.aborted) {
      this.context.assertAuthority()
      const state = await this.solve()
      if (!this.shouldVerify(state)) continue

      const verdict = await this.verify()
      if (!doneOf(verdict)) {
        this.reopen(verdict, 'verifier')
        await persist(this.context, this.runtime, 'reopened-by-verifier')
        continue
      }

      const verifiedAnswer = finalAnswerOf(verdict, this.runtime.candidateAnswer)
      if (verifiedAnswer) this.runtime.candidateAnswer = verifiedAnswer
      const review = await this.review(verdict)
      if (!doneOf(review)) {
        this.reopen(review, 'reviewer')
        await persist(this.context, this.runtime, 'reopened-by-reviewer')
        continue
      }

      const answer = finalAnswerOf(review, this.runtime.candidateAnswer)
      if (!answer.trim()) {
        this.reopen({ done: false, gaps: ['最终答案为空'], directive: '形成可直接交付的最终答案。', final_answer: '' }, 'empty-answer')
        continue
      }
      return {
        status: 'completed',
        result: {
          feature: 'chatgpt-subscription-long-think',
          answer,
          rounds: this.runtime.round,
          apiCalls: this.runtime.apiCalls,
          verifierRuns: this.runtime.verifierRuns,
          reviewerRuns: this.runtime.reviewerRuns,
          finalState: this.runtime.state,
        },
      }
    }
    return { status: 'cancelled', result: { feature: 'chatgpt-subscription-long-think' } }
  }
}

export const handleChatGptLongThinkJob: JobHandler = async context => {
  const input = parseInput(context.job.input)
  if (!input) return {
    status: 'failed',
    error: {
      code: 'CHATGPT_LONG_INVALID_INPUT',
      message: 'ChatGPT 长任务参数无效',
      retryable: false,
      class: 'user',
      details: {},
    },
  }
  const runtime = runtimeFrom(context.job.checkpoint?.data)
  return new Session(context, input, runtime).run()
}
