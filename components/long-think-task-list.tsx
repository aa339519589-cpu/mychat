import { LONG_THINK_ACTIVE, longThinkInteger, type ListedJob } from "@/components/long-think-support"

function statusText(status: string): string {
  if (LONG_THINK_ACTIVE.has(status)) return "处理中"
  if (status === "completed") return "已完成"
  if (status === "cancelled") return "已停止"
  if (status === "failed") return "失败"
  return status
}

function timeText(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : ""
}

export function LongThinkTaskList({ jobs, selectedId, onSelect, onNew }: {
  jobs: ListedJob[]
  selectedId: string
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return <section className="mt-5 rounded-[26px] border border-border/70 bg-card/35 p-4 sm:p-5">
    <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">长期任务</h2><p className="mt-1 text-xs text-muted-foreground">切换页面不会停止其他任务。</p></div><button onClick={onNew} className="fluid-press h-9 rounded-xl border border-border px-3 text-xs hover:bg-muted/50">+ 新任务</button></div>
    <div className="mt-4 grid gap-2">
      {jobs.length === 0 && <p className="py-3 text-center text-xs text-muted-foreground">还没有任务</p>}
      {jobs.map(item => {
        const progress = item.progress ?? {}
        const round = longThinkInteger(progress.round)
        const active = LONG_THINK_ACTIVE.has(item.status)
        return <button key={item.id} onClick={() => onSelect(item.id)} className={`fluid-press flex w-full items-center gap-3 rounded-2xl border p-3 text-left ${item.id === selectedId ? "border-foreground/35 bg-background" : "border-border/60 hover:bg-background/55"}`}>
          <span className={`size-2 shrink-0 rounded-full ${active ? "bg-foreground" : "bg-muted-foreground/35"}`} />
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{statusText(item.status)} · 第 {round} 轮</span><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{timeText(item.created_at)} · {item.id.slice(0, 8)}</span></span>
        </button>
      })}
    </div>
  </section>
}
