import { createAdminClient } from '@/lib/supabase/admin'
import { endpointAuthType, endpointOutputKind, getOwnedModelEndpoint, resolveModelEndpointKey } from '@/lib/model-endpoint-server'
import { isJsonValue, type JsonObject } from '@/lib/jobs/contracts'
import type { JobExecutionContext, JobHandler } from '@/lib/jobs/worker'
import { checkpointJson, parseLongThinkCheckpoint, parseLongThinkJobInput, type LongThinkRuntimeCheckpoint } from './contracts'
import { LongThinkProviderError, longThinkCompletion, type LongThinkCompletion, type LongThinkMessage } from './provider'

const SOLVER_SYSTEM = `你是一个长期任务执行器。目标不是尽快结束，而是把用户的问题真正闭环。每次调用只完成下一段最有价值的工作，然后输出一个可被下一次调用直接继承的状态快照。

规则：
1. 不要复述任务，不要写流程说明。
2. 状态必须自包含：下一轮只拿到原问题和这份状态也能继续。
3. 保留已验证结果、失败路线及失败原因、未解决缺口、下一步动作、必要公式/代码/数据/引用。
4. 不要因为单轮停止、输出长度或上下文压力草率结束。
5. 只有关键缺口全部关闭时 done 才能为 true。
6. 如果已经有候选答案，优先审查最脆弱部分。
7. 只输出一个 JSON 对象，不要 Markdown 围栏。

格式：
{"done":false,"progress_summary":"","established":[],"failed_routes":[{"route":"","reason":""}],"unresolved":[],"next_actions":[],"working_material":"","candidate_answer":""}`

这里保存的是跨轮可续接工作状态。`

const VERIFIER_SYSTEM = `你是长期任务的独立闭环审查器。你的职责是阻止未完成的问题被过早判定为完成。基于原问题、当前状态和候选答案，逐项检查用户要求、逻辑缺口、关键计算或事实验证、未处理的 unresolved，以及仍能改变最终结论的下一步。
只输出 JSON：{"done":false,"gaps":[],"directive":"","final_answer":""}。存在任何影响结论的核心缺口时 done 必须为 false。`

const REVIEWER_SYSTEM = `你是最终审查器。你只在独立 verifier 已认为任务完成后出现。重新检查原问题、最终状态、候选答案和 verifier 结论，寻找遗漏、自相矛盾、错误计算、错误引用、没有覆盖的用户要求或仍会改变结论的缺口。
只输出 JSON：{"done":false,"gaps":[],"directive":"","final_answer":""}。只有确认闭环时 done 才能为 true，并在 final_answer 给出可直接展示给用户的最终回复。`

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asJsonObject(value: unknown): JsonObject | null {
  return isJsonValue(value) && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function extractJsonObject(text: string): JsonObject | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const direct = asJsonObject(JSON.parse(trimmed))
    if (direct) return direct
  } catch { /* scan below */ }

  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== '{') continue
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < trimmed.length; index++) {
      const char = trimmed[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (char === '"') { quoted = true; continue }
      if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) {
          try {
            const parsed = asJsonObject(JSON.parse(trimmed.slice(start, index + 1)))
            if (parsed) return parsed
          } catch { break }
        }
      }
    }
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

function progress(runtime: LongThinkRuntimeCheckpoint): JsonObject {
  return {
    feature: 'long-think',
    state: 'thinking',
    round: runtime.round,
    apiCalls: runtime.usage.apiCalls,
    inputTokens: runtime.usage.inputTokens,
    outputTokens: runtime.usage.outputTokens,
    verifierRuns: runtime.verifierRuns,
    reviewerRuns: runtime.reviewerRuns,
  }
}

async function persist(context: JobExecutionContext, runtime: LongThinkRuntimeCheckpoint, phase: string): Promise<void> {
  await context.checkpoint({
    phase,
    checkpoint: checkpointJson(runtime),
    progress: progress(runtime),
    resumable: true,
    status: 'running',
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

function candidateOf(state: JsonObject, fallback: string): string {
  const value = state.candidate_answer
  return typeof value === 'string' ? value : fallback
}

function doneOf(state: JsonObject): boolean {
  return state.done === true
}

function gapsOf(value: JsonObject): unknown[] {
  return Array.isArray(value.gaps) ? value.gaps : []
}

function directiveOf(value: JsonObject): string {
  return typeof value.directive === 'string' ? value.directive : ''
}

function finalAnswerOf(value: JsonObject, fallback: string): string {
  return typeof value.final_answer === 'string' && value.final_answer.trim()
    ? value.final_answer
    : fallback
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
  try { apiKey = resolveModelEndpointKey(endpoint, context.job.principal.id) } catch {
    return {
      status: 'failed',
      error: { code: 'LONG_THINK_ENDPOINT_KEY', message: '模型端点凭据无法读取，请重新连接该端点', retryable: false, class: 'user', details: {} },
    }
  }

  const runtime = parseLongThinkCheckpoint(context.job.checkpoint?.data)
  let consecutiveErrors = 0

  const complete = async (messages: readonly LongThinkMessage[], maxTokens = input.maxTokens): Promise<LongThinkCompletion> => {
    const result = await longThinkCompletion({
      baseUrl: endpoint.base_url,
      apiKey,
      authType: endpointAuthType(endpoint.auth_type),
      model: endpoint.model,
      messages,
      maxTokens,
      signal: context.signal,
    })
    account(runtime, result)
    return result
  }

  const requestJson = async (messages: readonly LongThinkMessage[], maxTokens = input.maxTokens): Promise<JsonObject> => {
    const first = await complete(messages, maxTokens)
    let parsed = extractJsonObject(first.text)
    if (parsed) return parsed

    runtime.formatFailures += 1
    const repairSource = (first.text || first.reasoning).slice(0, 500_000)
    const repaired = await complete([
      { role: 'system', content: '把下面的模型工作结果转换成一个合法、完整、可续接的 JSON 对象。保留所有有用成果和未解决缺口。只输出 JSON，不要继续扩展答案。' },
      { role: 'user', content: repairSource },
    ], Math.min(maxTokens, 65_536))
    parsed = extractJsonObject(repaired.text)
    if (parsed) return parsed
    throw new LongThinkProviderError('模型连续返回无法解析的状态 JSON', { retryable: true })
  }

  while (true) {
    context.assertAuthority()
    try {
      const previous = runtime.round === 0 ? '（第一轮，没有旧状态）' : JSON.stringify(runtime.state)
      const state = await requestJson([
        { role: 'system', content: SOLVER_SYSTEM },
        { role: 'user', content: `原始问题：\n${input.problem}\n\n上一轮续接状态：\n${previous}\n\n当前轮次：${runtime.round + 1}\n\n继续工作。不要重新开始，优先处理 unresolved 和审查器留下的缺口。` },
      ])
      consecutiveErrors = 0
      runtime.round += 1
      runtime.state = state
      runtime.candidateAnswer = candidateOf(state, runtime.candidateAnswer)
      await persist(context, runtime, 'solving')

      const shouldVerify = runtime.round >= input.minRounds
        && (doneOf(state) || runtime.round % input.verifyEvery === 0)
      if (!shouldVerify) continue

      const verdict = await requestJson([
        { role: 'system', content: VERIFIER_SYSTEM },
        { role: 'user', content: `原始问题：\n${input.problem}\n\n当前续接状态：\n${JSON.stringify(runtime.state)}\n\n候选答案：\n${runtime.candidateAnswer || '（尚未形成完整候选答案）'}\n\n已完成轮数：${runtime.round}` },
      ], Math.min(input.maxTokens, 32_768))
      runtime.verifierRuns += 1

      if (!doneOf(verdict)) {
        runtime.state = {
          ...runtime.state,
          _closure_review: { gaps: gapsOf(verdict), directive: directiveOf(verdict) },
        }
        await persist(context, runtime, 'closure-review')
        continue
      }

      const verifiedAnswer = finalAnswerOf(verdict, runtime.candidateAnswer)
      const review = await requestJson([
        { role: 'system', content: REVIEWER_SYSTEM },
        { role: 'user', content: `原始问题：\n${input.problem}\n\n最终状态：\n${JSON.stringify(runtime.state)}\n\n候选答案：\n${verifiedAnswer}\n\nVerifier：\n${JSON.stringify(verdict)}` },
      ], Math.min(input.maxTokens, 32_768))
      runtime.reviewerRuns += 1

      if (!doneOf(review)) {
        runtime.state = {
          ...runtime.state,
          _final_review: { gaps: gapsOf(review), directive: directiveOf(review) },
        }
        runtime.candidateAnswer = verifiedAnswer
        await persist(context, runtime, 'final-review')
        continue
      }

      const finalAnswer = finalAnswerOf(review, verifiedAnswer)
      if (!finalAnswer.trim()) {
        runtime.state = {
          ...runtime.state,
          _final_review: { gaps: ['最终答案为空'], directive: '形成可直接交付给用户的最终答案' },
        }
        await persist(context, runtime, 'final-review')
        continue
      }

      return {
        status: 'completed',
        result: {
          feature: 'long-think',
          finalAnswer,
          round: runtime.round,
          apiCalls: runtime.usage.apiCalls,
          inputTokens: runtime.usage.inputTokens,
          outputTokens: runtime.usage.outputTokens,
          verifierRuns: runtime.verifierRuns,
          reviewerRuns: runtime.reviewerRuns,
        },
      }
    } catch (error) {
      if (context.signal.aborted) throw context.signal.reason
      const providerError = error instanceof LongThinkProviderError
        ? error
        : new LongThinkProviderError('长期任务模型调用失败', { retryable: true, cause: error })
      if (!providerError.retryable) return {
        status: 'failed',
        error: {
          code: 'LONG_THINK_PROVIDER_REJECTED',
          message: providerError.message,
          retryable: false,
          class: 'provider',
          details: providerError.status === null ? {} : { status: providerError.status },
        },
      }
      runtime.transientErrors += 1
      consecutiveErrors += 1
      await persist(context, runtime, 'solving')
      const delay = Math.min(300_000, 2_000 * (2 ** Math.min(consecutiveErrors - 1, 8)))
      await sleep(delay, context.signal)
    }
  }
}
