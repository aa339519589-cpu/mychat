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
  let lastHadToolCalls = false
  let lastTurn: TurnResult | null = null
  let consecutiveFailures = 0
  const MAX_CONSECUTIVE_FAILURES = 2
  let leakedRetriesThisRound = 0
  const MAX_LEAKED_RETRIES_PER_ROUND = 2

  for (let round = 0; round < maxRounds; round++) {
    let turn = await runTurn(url, apiKey, model, msgs, tools, emit, { thinking, adapter })
    totalTokens += turn.totalTokens
    onTurn?.({ phase: 'round', round, turn })

    // 网络级失败重试（延迟 1s，给上游恢复时间）
    if (turn.failed && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      consecutiveFailures++
      await new Promise(r => setTimeout(r, 1000))
      turn = await runTurn(url, apiKey, model, msgs, tools, emit, { thinking, adapter })
      totalTokens += turn.totalTokens
      onTurn?.({ phase: 'round', round, turn })
    }
    if (turn.failed) consecutiveFailures++
    else consecutiveFailures = 0

    // 工具协议泄漏：content 里有 DSML 等标记被剥掉了，但标准 tool_calls 为空。
    // 说明模型试图在正文里写工具调用（而非用标准 function calling）。
    // 无论正文是否为空、DSML 是否闭合，一律关工具让模型重述——宁可多一轮也比中断好。
    leakedRetriesThisRound = 0
    while (
      leakedRetry &&
      turn.leaked &&
      turn.toolCalls.length === 0 &&
      !turn.failed &&
      leakedRetriesThisRound < MAX_LEAKED_RETRIES_PER_ROUND
    ) {
      leakedRetriesThisRound++
      // 把已过滤的正文当作 assistant 消息接入，然后补一条用户指令
      if (turn.content.trim()) {
        msgs.push({ role: 'assistant', content: turn.content })
      }
      msgs.push({ role: 'user', content: '继续完成你的回复。禁止在正文中使用 DSML 或任何 <｜ ｜> 标记来调用工具——你必须使用标准的 function calling。如果你的上一条回复被截断了，请重新完整输出。' })
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

  // 长度截断自动续写 / 异常中断 / 不完整工具调用续写
  if (autoContinue && lastTurn && !lastTurn.failed) {
    let cur = lastTurn
    let cont = 0
    while (cont < autoContinue.maxContinuations && !cur.failed) {
      const needContinue = cur.finishReason === 'length' || cur.truncated || cur.hasIncompleteToolCall
      if (!needContinue) break
      cont++
      msgs.push({ role: 'assistant', content: cur.content })
      msgs.push({ role: 'user', content: '紧接上文继续输出剩余内容，不要重复已经写过的部分，也不要加任何开场白。如果之前在正文中使用了 DSML 工具调用格式，请改用标准的 function calling 或直接用文字说明。' })
      cur = await runTurn(url, apiKey, model, msgs, [], emit, { thinking, adapter })
      totalTokens += cur.totalTokens
      onTurn?.({ phase: 'continue', round: cont, turn: cur })
    }
    if (!cur.failed && cur.finishReason === 'length' && cont >= autoContinue.maxContinuations) {
      emit({ text: '\n\n（内容较长，已输出至上限，可回复”继续”获取后续。）' })
    } else if (!cur.failed && (cur.truncated || cur.hasIncompleteToolCall)) {
      emit({ text: '\n\n（回复异常中断，请点击重新生成。）' })
    }
  }

  return { totalTokens }
}
