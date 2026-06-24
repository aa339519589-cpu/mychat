// 唯一的多轮 agent 循环：两个 route（chat / code）共用，差异完全靠配置开关表达，
// 不再各自复制一份循环导致行为漂移。
//
// 流程：循环 N 轮 → 每轮一次 runTurn →（可选）泄漏重试 → 有工具调用则执行并回灌、继续；
// 无工具调用则结束 → 若结束时仍带工具调用，补一轮纯文本 → （可选）length 截断自动续写。
import { runTurn, type TurnResult } from './turn'
import type { Emit } from './events'
import type { ProviderAdapterId } from './provider-adapters'

// 执行单个工具，返回回灌给模型的文字；工具自身需要的前端事件由实现内部 emit。
export type ExecuteTool = (name: string, input: any) => Promise<string>

export type TurnPhase = 'round' | 'leaked-retry' | 'final-text' | 'continue'

export type AgentLoopOpts = {
  url: string
  apiKey: string
  model: string
  adapter?: ProviderAdapterId
  thinking: boolean
  messages: any[]            // 原地追加 assistant / tool 消息
  tools: any[]               // provider 格式的工具数组（空数组 = 不带工具）
  emit: Emit
  executeTool: ExecuteTool
  maxRounds: number
  // chat：工具协议泄漏成正文且无可用内容时，关工具重试一轮
  leakedRetry?: boolean
  // chat：finish_reason === 'length' 时自动续写，前端无感拼接
  autoContinue?: { maxContinuations: number }
  // 诊断日志钩子（循环本身不做日志，交给调用方）
  onTurn?: (info: { phase: TurnPhase; round?: number; turn: TurnResult }) => void
}

export async function runAgentLoop(opts: AgentLoopOpts): Promise<{ totalTokens: number }> {
  const { url, apiKey, model, adapter, thinking, messages: msgs, tools, emit, executeTool, maxRounds, leakedRetry, autoContinue, onTurn } = opts
  let totalTokens = 0
  let retriedNoTools = false
  let lastHadToolCalls = false
  let lastTurn: TurnResult | null = null

  for (let round = 0; round < maxRounds; round++) {
    let turn = await runTurn(url, apiKey, model, msgs, tools, emit, { thinking, adapter })
    totalTokens += turn.totalTokens
    onTurn?.({ phase: 'round', round, turn })

    // 工具协议泄漏成正文、又没有结构化工具调用、过滤后没正文 → 该 provider 此刻工具不可靠，关工具重试一轮
    if (leakedRetry && turn.leaked && turn.toolCalls.length === 0 && !turn.content.trim() && !retriedNoTools && !turn.failed) {
      retriedNoTools = true
      turn = await runTurn(url, apiKey, model, msgs, [], emit, { thinking, adapter })
      totalTokens += turn.totalTokens
      onTurn?.({ phase: 'leaked-retry', round, turn })
    }

    lastTurn = turn
    lastHadToolCalls = turn.toolCalls.length > 0
    if (turn.failed || !lastHadToolCalls) break
    msgs.push(turn.assistantMessage)
    for (const tc of turn.toolCalls) {
      let input: any = {}
      try { input = JSON.parse(tc.args || '{}') } catch {}
      const result = await executeTool(tc.name, input)
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: result })
    }
  }

  // 轮次用完但最后一轮还有工具调用 → 补一轮纯文本请求，确保有完整回复
  if (lastHadToolCalls) {
    lastTurn = await runTurn(url, apiKey, model, msgs, [], emit, { thinking, adapter })
    totalTokens += lastTurn.totalTokens
    onTurn?.({ phase: 'final-text', turn: lastTurn })
  }

  // 长度截断自动续写 / 异常中断提示
  if (autoContinue && lastTurn && !lastTurn.failed) {
    let cur = lastTurn
    let cont = 0
    while (cur.finishReason === 'length' && cont < autoContinue.maxContinuations && !cur.failed) {
      cont++
      msgs.push({ role: 'assistant', content: cur.content })
      msgs.push({ role: 'user', content: '紧接上文继续输出剩余内容，不要重复已经写过的部分，也不要加任何开场白。' })
      cur = await runTurn(url, apiKey, model, msgs, [], emit, { thinking, adapter })
      totalTokens += cur.totalTokens
      onTurn?.({ phase: 'continue', round: cont, turn: cur })
    }
    if (!cur.failed && cur.finishReason === 'length') {
      emit({ text: '\n\n（内容较长，已输出至上限，可回复“继续”获取后续。）' })
    } else if (!cur.failed && cur.truncated) {
      emit({ text: '\n\n（回复异常中断，请点击重新生成。）' })
    }
  }

  return { totalTokens }
}
