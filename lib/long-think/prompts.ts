import type { JsonObject } from '@/lib/jobs/contracts'
import type { LongThinkRuntimeCheckpoint } from './contracts'

export function solverUserMessage(problem: string, previous: string, round: number, sharedContext: string): string {
  return [
    '原始问题：', problem,
    '', 'MyChat 共享记忆 / 历史上下文：', sharedContext,
    '', '上一轮续接状态：', previous,
    '', '当前轮次：' + String(round),
    '', '继续工作。不要重新开始。优先处理 unresolved、审查器留下的缺口和 _capability_results。需要外部资料时主动请求联网工具。',
  ].join('\n')
}

export function verifierUserMessage(problem: string, runtime: LongThinkRuntimeCheckpoint): string {
  return ['原始问题：', problem, '', '当前续接状态：', JSON.stringify(runtime.state), '', '候选答案：',
    runtime.candidateAnswer || '（尚未形成完整候选答案）', '', '已完成轮数：' + String(runtime.round)].join('\n')
}

export function reviewerUserMessage(problem: string, runtime: LongThinkRuntimeCheckpoint, answer: string, verdict: JsonObject): string {
  return ['原始问题：', problem, '', '最终状态：', JSON.stringify(runtime.state), '', '候选答案：', answer,
    '', 'Verifier：', JSON.stringify(verdict)].join('\n')
}
