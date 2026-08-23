import type { JobSnapshot } from "@/components/long-think-support"

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string").slice(0, 12)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return <div><div className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-muted-foreground">{title}</div><div className="space-y-1 text-sm leading-6">{items.map((item, index) => <div key={`${title}-${index}`} className="break-words">{item}</div>)}</div></div>
}

export function LongThinkProgress({ job }: { job: JobSnapshot | null }) {
  const progress = job?.progress ?? {}
  const summary = text(progress.progressSummary)
  const material = text(progress.workingMaterial)
  const established = strings(progress.established)
  const unresolved = strings(progress.unresolved)
  const nextActions = strings(progress.nextActions)
  const hasCheckpoint = Boolean(summary || material || established.length || unresolved.length || nextActions.length)

  return <div className="mt-5 rounded-2xl border border-border/70 bg-background/55 p-4 sm:p-5">
    <div className="mb-3 text-xs font-medium text-muted-foreground">当前推理进展</div>
    {!hasCheckpoint && <p className="text-sm leading-6 text-muted-foreground">正在等待当前轮模型返回。首轮完成后，这里会持续显示每轮保留下来的研究进展、已确认结果、未解决问题和下一步。</p>}
    {summary && <div className="mb-4 whitespace-pre-wrap break-words text-sm leading-6">{summary}</div>}
    <div className="grid gap-4 md:grid-cols-3">
      <ListBlock title="已确认" items={established} />
      <ListBlock title="未解决" items={unresolved} />
      <ListBlock title="下一步" items={nextActions} />
    </div>
    {material && <details className="mt-4"><summary className="cursor-pointer text-xs text-muted-foreground">展开当前工作材料</summary><div className="mt-3 max-h-[34rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 p-3 text-sm leading-6">{material}</div></details>}
  </div>
}
