import type { MaestroPhase } from "@/lib/maestro/store"

type ContinuationOptions = {
  objective: string
  successCriterion: string
  hardRules: string[]
  nextRound: number
  phase: MaestroPhase
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  candidateAnswer: string
}

export function maestroContinuationPrompt(options: ContinuationOptions): string {
  const state = JSON.stringify({
    checkpoint: options.checkpoint,
    unresolved: options.unresolved,
    nextActions: options.nextActions,
    evidence: options.evidence,
    candidateAnswer: options.candidateAnswer,
  })
  const contract = [
    `目标：${options.objective}`,
    `成功判据（不可修改、不可弱化）：${options.successCriterion}`,
    `硬规则：${JSON.stringify(options.hardRules)}`,
  ]
  const telemetry = "调用 maestro_round_gate 时，roundOutput 必须填写本轮可向用户展示的完整工作产物或结果摘要，不得包含隐藏思维链。"

  if (options.phase === "review") {
    return [
      `继续 Maestro Runner 任务，第 ${options.nextRound} 轮，阶段 review。`,
      ...contract,
      `上一阶段候选答案与检查点：${state}`,
      telemetry,
      "这是独立复核轮。必须按原始成功判据逐项核验，主动寻找错误、遗漏、未经证明的跳步；不得因为耗时、轮数、难度、工具限制或没有进展而判定完成。",
      "若存在任何实质缺口：done=false、criterionSatisfied=false、completionVerified=false，提交未解决项和下一步，系统返回工作轮继续。",
      "只有原始成功判据已经被实际满足且复核证据充分时：done=true、criterionSatisfied=true、completionVerified=true、reviewEvidence 至少一项，并提交完整 finalAnswer。",
      "调用工具后结束这一轮，不要等待用户手动说继续。",
    ].join("\n\n")
  }

  return [
    `继续 Maestro Runner 任务，第 ${options.nextRound} 轮，阶段 work。`,
    ...contract,
    `上一轮持久检查点：${state}`,
    telemetry,
    "直接推进尚未闭环的工作。不得把‘需要继续’、未知方法、运行时边界、时间不足或无法完成当作完成。",
    "本轮结束前必须调用 maestro_round_gate。若原始成功判据尚未实际满足，done=false、criterionSatisfied=false、completionVerified=false，并提交 checkpoint、unresolved、nextActions、evidence、roundOutput。",
    "只有工作结果已满足原始成功判据时才可提交 done=true、criterionSatisfied=true 和完整 finalAnswer；工作轮自身仍不能结束任务，系统必须进入独立 review。",
    "调用工具后结束这一轮；Runner 自动创建下一轮，不需要用户手动发送‘继续’。",
  ].join("\n\n")
}
