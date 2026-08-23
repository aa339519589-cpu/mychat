"use client"

import { useEffect, useState } from "react"
import { BrainCircuit, CircleStop, LoaderCircle, Plus } from "lucide-react"
import { LONG_THINK_ACTIVE as ACTIVE, formatLongThinkElapsed as formatElapsed, longThinkInteger as integer, longThinkNullableInteger as nullableInteger, longThinkResultAnswer as resultAnswer, type JobSnapshot } from "@/components/long-think-support"
import { stopLongThinkTask } from "@/components/use-long-think"
import { LongThinkProgress } from "@/components/long-think-progress"

type View = { active: boolean; title: string; round: number; apiCalls: number; elapsed: string; inputTokens: string; outputTokens: string; completed: boolean; failed: boolean; finalAnswer: string; errorCode: string }

function tokenText(value: unknown): string {
  const parsed = nullableInteger(value)
  return parsed === null ? "未知" : parsed.toLocaleString()
}

function title(status: string, active: boolean): string {
  if (active) return "深度处理中"
  if (status === "completed") return "已闭环"
  if (status === "cancelled") return "已停止"
  return "任务结束"
}

function viewOf(job: JobSnapshot | null, now: number): View {
  if (!job) return { active: true, title: "深度处理中", round: 0, apiCalls: 0, elapsed: "0秒", inputTokens: "未知", outputTokens: "未知", completed: false, failed: false, finalAnswer: "", errorCode: "UNKNOWN" }
  const active = ACTIVE.has(job.status)
  const started = job.startedAt ?? job.createdAt
  return { active, title: title(job.status, active), round: integer(job.progress.round), apiCalls: integer(job.progress.apiCalls), elapsed: formatElapsed((now - Date.parse(started)) / 1000), inputTokens: tokenText(job.progress.inputTokens), outputTokens: tokenText(job.progress.outputTokens), completed: job.status === "completed", failed: job.status === "failed", finalAnswer: resultAnswer(job.result), errorCode: job.errorCode ?? "UNKNOWN" }
}

export function LongThinkRunning({ jobId, job, onNew }: { jobId: string; job: JobSnapshot | null; onNew: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const view = viewOf(job, now)
  const stop = async () => {
    setBusy(true); setError("")
    try { await stopLongThinkTask(jobId) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "停止失败") }
    finally { setBusy(false) }
  }

  return <section className="mt-5 rounded-[30px] border border-border/70 bg-card/50 p-5 sm:p-7">
    <div className="flex items-start gap-3"><div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background">{view.active ? <LoaderCircle className="size-4 animate-spin" /> : <BrainCircuit className="size-4" />}</div><div className="min-w-0 flex-1"><h2 className="text-base font-semibold">{view.title}</h2><div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>轮次 <b className="font-medium text-foreground">{view.round}</b></span><span>API 调用 <b className="font-medium text-foreground">{view.apiCalls}</b></span><span>运行 <b className="font-medium text-foreground">{view.elapsed}</b></span><span>输入 Token <b className="font-medium text-foreground">{view.inputTokens}</b></span><span>输出 Token <b className="font-medium text-foreground">{view.outputTokens}</b></span></div></div><div className="flex gap-2"><button onClick={onNew} className="fluid-press flex h-10 items-center gap-1.5 rounded-xl border border-border px-3 text-xs hover:bg-muted/50"><Plus className="size-4" />新任务</button>{view.active && <button disabled={busy} onClick={() => void stop()} className="fluid-press flex h-10 items-center gap-1.5 rounded-xl border border-border px-3 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-50"><CircleStop className="size-4" />停止</button>}</div></div>
    <LongThinkProgress job={job} />
    {view.completed && view.finalAnswer && <div className="mt-6 whitespace-pre-wrap break-words rounded-2xl border border-border/70 bg-background p-4 text-[15px] leading-7 sm:p-6">{view.finalAnswer}</div>}
    {view.failed && <div className="mt-5 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">任务失败：{view.errorCode}</div>}
    {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
  </section>
}
