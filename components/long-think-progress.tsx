import type { JobSnapshot } from "@/components/long-think-support"

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, 12)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function phaseText(value: unknown): string {
  if (value === "model-call" || value === "model-stream") return "模型正在生成"
  if (value === "tools") return "联网 / Memory 结果已写入"
  if (value === "verifying") return "闭环审查中"
  if (value === "final-reviewing") return "最终复核中"
  if (value === "retrying") return "接口恢复中"
  if (value === "closure-review" || value === "final-review") return "审查结果已写入，继续处理"
  return "持续处理中"
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return <div><div className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground">{title}</div><div className="space-y-1 text-sm leading-6">{items.map((item, index) => <div key={`${title}-${index}`} className="break-words">{item}</div>)}</div></div>
}

export function LongThinkProgress({ job }: { job: JobSnapshot | null }) {
  const progress = job?.progress ?? {}
  const summary = text(progress.progressSummary)
  const material = text(progress.workingMaterial)
  const reasoning = text(progress.providerReasoning)
  const streamText = text(progress.providerStreamText)
  const activity = strings(progress.capabilityActivity)
  const established = strings(progress.established)
  const unresolved = strings(progress.unresolved)
  const nextActions = strings(progress.nextActions)
  const liveText = reasoning || streamText
  const liveLabel = reasoning ? "模型接口返回的 reasoning" : "模型当前输出流"
  const hasCheckpoint = Boolean(summary || material || established.length || unresolved.length || nextActions.length)

  return <div className="mt-5 rounded-2xl border border-border/70 bg-background/55 p-4 sm:p-5">
    <div className="flex items-center justify-between gap-3"><div className="text-xs font-medium text-muted-foreground">当前推理进展</div><div className="text-[11px] text-foreground">{phaseText(progress.phase)}</div></div>
    {liveText ? <div className="mt-3 max-h-[28rem] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-background p-3 text-sm leading-6"><div className="mb-2 text-[11px] text-muted-foreground">{liveLabel}</div>{liveText}</div> : <p className="mt-3 text-sm leading-6 text-muted-foreground">当前请求正在执行；接口暂时还没有返回可展示的 reasoning 或输出片段。</p>}
    {activity.length > 0 && <div className="mt-4 rounded-xl border border-border/60 p-3"><div className="mb-2 text-[11px] font-medium text-muted-foreground">联网 / Memory 活动</div><div className="space-y-1 text-xs leading-5">{activity.map((item, index) => <div key={`${item}-${index}`}>{item}</div>)}</div></div>}
    {!hasCheckpoint && <p className="mt-3 text-sm leading-6 text-muted-foreground">首轮 checkpoint 尚未生成。首轮完成后会持续显示已确认结果、未解决问题和下一步。</p>}
    {summary && <div className="mt-4 whitespace-pre-wrap break-words text-sm leading-6">{summary}</div>}
    <div className="mt-4 grid gap-4 md:grid-cols-3"><ListBlock title="已确认" items={established} /><ListBlock title="未解决" items={unresolved} /><ListBlock title="下一步" items={nextActions} /></div>
    {material && <details className="mt-4"><summary className="cursor-pointer text-xs text-muted-foreground">展开当前工作材料</summary><div className="mt-3 max-h-[34rem] overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-xl border border-border/60 p-3 text-sm leading-6">{material}</div></details>}
  </div>
}
