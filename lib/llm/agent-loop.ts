// Shared multi-round Agent loop for both chat and code jobs. Provider calls,
// durable usage, checkpoints, and tool effects intentionally stay ordered.
import { runTurn, type RunTurnOptions, type TurnResult } from './turn'
import type { Emit } from './events'
import type { ProviderAdapterId } from './provider-adapters'
import type { ModelMessage, ModelToolDefinition } from './types'

export type ExecuteTool = (
  name: string,
  input: unknown,
  execution?: { toolCallId: string },
) => Promise<string>

type TurnPhase = 'round' | 'leaked-retry' | 'final-text' | 'continue'
type RoundAction = 'continue' | 'break'

export type AgentLoopOpts = {
  url: string
  apiKey: string
  model: string
  adapter?: ProviderAdapterId
  thinking: boolean
  reasoningEffort?: import('./provider-adapters').ReasoningEffort | null
  messages: ModelMessage[]
  tools: ModelToolDefinition[]
  emit: Emit
  executeTool: ExecuteTool
  maxRounds?: number
  leakedRetry?: boolean
  autoContinue?: { maxContinuations?: number }
  idleContinuation?: {
    maxContinuations?: number
    prompt: (info: { turn: TurnResult; idleCount: number }) => string | null | Promise<string | null>
  }
  onTurn?: (info: { phase: TurnPhase; round?: number; turn: TurnResult }) => void
  onCheckpoint?: (messages: ModelMessage[]) => void | Promise<void>
  onUsage?: (totalTokens: number) => void | Promise<void>
  turnOptions?: Omit<RunTurnOptions, 'thinking' | 'adapter'>
}

type AgentLoopState = {
  totalTokens: number
  lastHadToolCalls: boolean
  lastTurn: TurnResult | null
  consecutiveFailures: number
  idleCount: number
  activeTurnTools: ModelToolDefinition[]
}

type AgentLoopContext = {
  options: AgentLoopOpts
  state: AgentLoopState
  sharedTurnOptions: RunTurnOptions
}

const MAX_CONSECUTIVE_FAILURES = 2
const MAX_LEAKED_RETRIES_PER_ROUND = 2
const LEAKED_RETRY_PROMPT = '继续完成你的回复。禁止在正文中使用 DSML 或任何 <｜ ｜> 标记来调用工具——你必须使用标准的 function calling。如果你的上一条回复被截断了，请重新完整输出。'
const OUTPUT_CONTINUATION_PROMPT = '紧接上文继续输出剩余内容，不要重复已经写过的部分，也不要加任何开场白。如果之前在正文中使用了 DSML 工具调用格式，请改用标准的 function calling 或直接用文字说明。'

function createContext(options: AgentLoopOpts): AgentLoopContext {
  return {
    options,
    state: {
      totalTokens: 0,
      lastHadToolCalls: false,
      lastTurn: null,
      consecutiveFailures: 0,
      idleCount: 0,
      activeTurnTools: options.tools,
    },
    sharedTurnOptions: {
      ...options.turnOptions,
      mediaBudget: options.turnOptions?.mediaBudget ?? { remaining: 4, seen: new Set<string>() },
    },
  }
}

async function recordUsage(context: AgentLoopContext, tokens: number): Promise<void> {
  context.state.totalTokens += tokens
  await context.options.onUsage?.(context.state.totalTokens)
}

async function executeTurn(
  context: AgentLoopContext,
  tools: ModelToolDefinition[],
  phase: TurnPhase,
  round?: number,
): Promise<TurnResult> {
  const options = context.options
  const turn = await runTurn(
    options.url,
    options.apiKey,
    options.model,
    options.messages,
    tools,
    options.emit,
    {
      thinking: options.thinking,
      adapter: options.adapter,
      reasoningEffort: options.reasoningEffort,
      ...context.sharedTurnOptions,
      emitErrors: false,
    },
  )
  await recordUsage(context, turn.totalTokens)
  options.onTurn?.(round === undefined ? { phase, turn } : { phase, round, turn })
  return turn
}

function shouldFallbackWithoutTools(context: AgentLoopContext, turn: TurnResult): boolean {
  return turn.failed
    && context.options.adapter === 'generic-openai'
    && context.state.activeTurnTools.length > 0
}

async function executeRoundTurn(
  context: AgentLoopContext,
  round: number,
): Promise<TurnResult | null> {
  let turn = await executeTurn(context, context.state.activeTurnTools, 'round', round)
  if (shouldFallbackWithoutTools(context, turn)) {
    context.state.activeTurnTools = []
    turn = await executeTurn(context, context.state.activeTurnTools, 'round', round)
  }
  if (turn.failed && context.state.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
    context.state.consecutiveFailures++
    await new Promise(resolve => setTimeout(resolve, 1_000))
    turn = await executeTurn(context, context.state.activeTurnTools, 'round', round)
  }
  if (turn.failed) {
    context.state.consecutiveFailures++
    context.state.lastTurn = turn
    if (context.state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new Error(turn.error || '模型连接连续失败')
    }
    return null
  }
  context.state.consecutiveFailures = 0
  return turn
}

function needsLeakedRetry(context: AgentLoopContext, turn: TurnResult): boolean {
  return context.options.leakedRetry === true
    && turn.leaked
    && turn.toolCalls.length === 0
    && !turn.failed
}

async function handleLeakedRetry(
  context: AgentLoopContext,
  initialTurn: TurnResult,
  round: number,
): Promise<RoundAction> {
  let turn = initialTurn
  let retries = 0
  while (retries < MAX_LEAKED_RETRIES_PER_ROUND
    && turn.leaked
    && turn.toolCalls.length === 0
    && !turn.failed) {
    retries++
    if (turn.content.trim()) {
      context.options.messages.push({ role: 'assistant', content: turn.content })
    }
    context.options.messages.push({ role: 'user', content: LEAKED_RETRY_PROMPT })
    await context.options.onCheckpoint?.(context.options.messages)
    turn = await executeTurn(context, [], 'leaked-retry', round)
  }
  context.state.lastTurn = turn
  if (!turn.failed && turn.content.trim()) {
    context.options.messages.push({ role: 'assistant', content: turn.content })
    await context.options.onCheckpoint?.(context.options.messages)
    return 'continue'
  }
  if (turn.failed) return 'continue'
  context.state.lastHadToolCalls = false
  return 'break'
}

function mayContinueIdle(context: AgentLoopContext): boolean {
  const continuation = context.options.idleContinuation
  return Boolean(continuation)
    && (continuation?.maxContinuations === undefined
      || context.state.idleCount < continuation.maxContinuations)
}

async function handleIdleTurn(context: AgentLoopContext, turn: TurnResult): Promise<RoundAction> {
  if (!mayContinueIdle(context)) return 'break'
  const prompt = await context.options.idleContinuation?.prompt({
    turn,
    idleCount: context.state.idleCount,
  })
  if (!prompt) return 'break'
  if (turn.content.trim()) {
    context.options.messages.push({ role: 'assistant', content: turn.content })
  }
  context.options.messages.push({ role: 'user', content: prompt })
  await context.options.onCheckpoint?.(context.options.messages)
  context.state.idleCount++
  return 'continue'
}

function parseToolInput(arguments_: string): { valid: true; value: unknown } | { valid: false } {
  try {
    return { valid: true, value: JSON.parse(arguments_ || '{}') as unknown }
  } catch {
    return { valid: false }
  }
}

async function executeToolCalls(context: AgentLoopContext, turn: TurnResult): Promise<void> {
  if (turn.assistantMessage) context.options.messages.push(turn.assistantMessage)
  // Persist provider-issued call ids before the first external side effect.
  await context.options.onCheckpoint?.(context.options.messages)
  for (const toolCall of turn.toolCalls) {
    const input = parseToolInput(toolCall.args)
    if (!input.valid) {
      context.options.messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: '工具参数不是有效 JSON，未执行。请修正参数后重新调用。',
      })
      continue
    }
    const result = await context.options.executeTool(
      toolCall.name,
      input.value,
      { toolCallId: toolCall.id },
    )
    context.options.messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: result,
    })
  }
  await context.options.onCheckpoint?.(context.options.messages)
}

async function processSuccessfulTurn(
  context: AgentLoopContext,
  turn: TurnResult,
  round: number,
): Promise<RoundAction> {
  if (needsLeakedRetry(context, turn)) return handleLeakedRetry(context, turn, round)
  context.state.lastTurn = turn
  context.state.lastHadToolCalls = turn.toolCalls.length > 0
  if (!context.state.lastHadToolCalls) return handleIdleTurn(context, turn)
  context.state.idleCount = 0
  await executeToolCalls(context, turn)
  return 'continue'
}

async function executeRounds(context: AgentLoopContext): Promise<void> {
  const maximum = context.options.maxRounds
  for (let round = 0; maximum === undefined || round < maximum; round++) {
    const turn = await executeRoundTurn(context, round)
    if (!turn) continue
    if (await processSuccessfulTurn(context, turn, round) === 'break') break
  }
}

async function requestFinalText(context: AgentLoopContext): Promise<void> {
  if (!context.state.lastHadToolCalls) return
  context.state.lastTurn = await executeTurn(context, [], 'final-text')
}

function needsOutputContinuation(turn: TurnResult): boolean {
  return turn.finishReason === 'length' || turn.truncated || turn.hasIncompleteToolCall
}

function continuationAvailable(context: AgentLoopContext, count: number): boolean {
  const maximum = context.options.autoContinue?.maxContinuations
  return maximum === undefined || count < maximum
}

function emitContinuationWarning(
  context: AgentLoopContext,
  turn: TurnResult,
  count: number,
): void {
  if (turn.failed) return
  const maximum = context.options.autoContinue?.maxContinuations
  if (turn.finishReason === 'length' && maximum !== undefined && count >= maximum) {
    context.options.emit({ text: '\n\n（内容较长，已输出至上限，可回复”继续”获取后续。）' })
    return
  }
  if (turn.truncated || turn.hasIncompleteToolCall) {
    context.options.emit({ text: '\n\n（回复异常中断，请点击重新生成。）' })
  }
}

async function continueOutput(context: AgentLoopContext): Promise<void> {
  if (!context.options.autoContinue
    || !context.state.lastTurn
    || context.state.lastTurn.failed) return
  let turn = context.state.lastTurn
  let count = 0
  while (continuationAvailable(context, count) && !turn.failed) {
    if (!needsOutputContinuation(turn)) break
    count++
    context.options.messages.push({ role: 'assistant', content: turn.content })
    context.options.messages.push({ role: 'user', content: OUTPUT_CONTINUATION_PROMPT })
    await context.options.onCheckpoint?.(context.options.messages)
    turn = await executeTurn(context, [], 'continue', count)
  }
  emitContinuationWarning(context, turn, count)
}

export async function runAgentLoop(options: AgentLoopOpts): Promise<{ totalTokens: number }> {
  const context = createContext(options)
  await executeRounds(context)
  await requestFinalText(context)
  await continueOutput(context)
  return { totalTokens: context.state.totalTokens }
}
