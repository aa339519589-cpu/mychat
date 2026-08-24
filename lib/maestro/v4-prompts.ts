import type { MaestroPhase } from "@/lib/maestro/store"

type Options = {
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

export function maestroV4Prompt(options: Options): string {
  const state = JSON.stringify({
    checkpoint: options.checkpoint,
    unresolved: options.unresolved,
    nextActions: options.nextActions,
    evidence: options.evidence,
    candidateAnswer: options.candidateAnswer,
  })
  const contract = [
    `目标：${options.objective}`,
    `不可变成功判据：${options.successCriterion}`,
    `不可变硬规则：${JSON.stringify(options.hardRules)}`,
  ]
  const common = [
    "不得因为耗时、轮数、token/工具限制、平台中断、没有已知方法、无法解决或缺少进展而宣布完成；这些情况必须保持未完成并继续。",
    "本轮结束前必须调用 maestro_round_gate，并提交可恢复 checkpoint、unresolved、nextActions、evidence、roundOutput；不要提交隐藏思维链。",
  ]

  if (options.phase === "review") {
    return [
      `Maestro Runner 第 ${options.nextRound} 轮 · 独立 review。`,
      ...contract,
      `上一阶段状态：${state}`,
      ...common,
      "逐项核验候选答案是否真正满足原始成功判据。不要默认候选答案正确。",
      "若存在任何实质缺口：done=false、criterionSatisfied=false、reviewEvidence 写已检查到的证据，并列出未解决项；系统回到 work。",
      "只有成功判据已被实际验证：done=true、criterionSatisfied=true、reviewEvidence 至少一项、unresolved=[]、nextActions=[]，并提交完整 finalAnswer。",
      "工具返回后结束本轮；Runner 自动发起下一轮或停止。",
    ].join("\n\n")
  }

  return [
    `Maestro Runner 第 ${options.nextRound} 轮 · work。`,
    ...contract,
    `上一轮状态：${state}`,
    ...common,
    "直接推进尚未闭环的实质工作。",
    "work 轮永远不能直接完成任务。仅当已形成一个声称完整满足成功判据的候选答案时，才可 done=true 并提交完整 finalAnswer；服务器只会转入独立 review。其他情况 done=false。",
    "work 阶段 criterionSatisfied 必须为 false，reviewEvidence 必须为空数组。",
    "工具返回后结束本轮；Runner 自动发起下一轮。",
  ].join("\n\n")
}
