"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { ArrowLeft, BrainCircuit, CircleStop, LoaderCircle } from "lucide-react"
import { LONG_THINK_ACTIVE as ACTIVE, formatLongThinkElapsed as formatElapsed, longThinkInteger as integer, longThinkNullableInteger as nullableInteger, longThinkResultAnswer as resultAnswer, type JobSnapshot } from "@/components/long-think-support"
import { startLongThinkTask, stopLongThinkTask, useLongThinkJob } from "@/components/use-long-think"

function Header() {
  return <header className="flex items-center gap-3 py-3">
    <Link href="/" aria-label="返回 MyChat" className="fluid-press flex size-10 items-center justify-center rounded-full border border-border/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground"><ArrowLeft className="size-4" /></Link>
    <div><div className="flex items-center gap-2"><BrainCircuit className="size-4" /><h1 className="font-heading text-xl font-semibold tracking-[-0.02em]">Long Think</h1></div><p className="mt-0.5 text-xs text-muted-foreground">后台连续处理，闭环后再交付最终答案</p></div>
  </header>
}

function Setup({ onStarted }: { onStarted: (jobId: string) => void }) {
  const [baseUrl, setBaseUrl] = useState("https://api.b.ai/v1")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("deepseek-v4-flash")
  const [problem, setProblem] = useState("")
  const [maxTokens, setMaxTokens] = useState(32768)
  const [minRounds, setMinRounds] = useState(4)
  const [verifyEvery, setVerifyEvery] = useState(6)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const start = async () => {
    setBusy(true); setError("")
    try {
      const jobId = await startLongThinkTask({ baseUrl, apiKey, model, problem, maxTokens, minRounds, verifyEvery })
      setApiKey("")
      onStarted(jobId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务创建失败")
    } finally { setBusy(false) }
  }

  return <section className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
    <div className="rounded-[28px] border border-border/70 bg-card/55 p-4 sm:p-6">
      <label className="mb-2 block text-xs text-muted-foreground">API URL</label><input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none" />
      <label className="mb-2 mt-4 block text-xs text-muted-foreground">API Key</label><input value={apiKey} onChange={event => setApiKey(event.target.value)} type="password" autoComplete="off" placeholder="sk-..." className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none" />
      <label className="mb-2 mt-4 block text-xs text-muted-foreground">模型</label><input value={model} onChange={event => setModel(event.target.value)} className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none" />
      <label className="mb-2 mt-5 block text-xs text-muted-foreground">问题</label><textarea value={problem} onChange={event => setProblem(event.target.value)} rows={12} placeholder="把需要真正闭环的问题完整写在这里" className="w-full resize-y rounded-2xl border border-border bg-background p-4 text-[15px] leading-6 outline-none" />
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <button disabled={busy} onClick={() => void start()} className="fluid-press mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-foreground px-5 text-sm font-medium text-background disabled:opacity-50">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <BrainCircuit className="size-4" />}开始连续处理</button>
    </div>
    <aside className="rounded-[28px] border border-border/70 bg-card/40 p-4 sm:p-5">
      <div className="text-xs font-medium text-muted-foreground">参数</div>
      <label className="mt-4 block text-xs text-muted-foreground">单轮最大输出 Token</label><input type="number" min={512} max={262144} value={maxTokens} onChange={event => setMaxTokens(Number(event.target.value) || 32768)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
      <label className="mt-4 block text-xs text-muted-foreground">最少处理轮数</label><input type="number" min={1} value={minRounds} onChange={event => setMinRounds(Number(event.target.value) || 4)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
      <label className="mt-4 block text-xs text-muted-foreground">闭环审查间隔</label><input type="number" min={1} value={verifyEvery} onChange={event => setVerifyEvery(Number(event.target.value) || 6)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
      <p className="mt-5 text-xs leading-5 text-muted-foreground">关闭网页不会停止任务。每轮成果写入持久化 checkpoint 后再进入下一轮。</p>
    </aside>
  </section>
}

function Running({ jobId, job, onNew }: { jobId: string; job: JobSnapshot | null; onNew: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  const active = !job || ACTIVE.has(job.status)
  const started = job?.startedAt ?? job?.createdAt
  const elapsed = started ? (now - Date.parse(started)) / 1000 : 0
  const finalAnswer = resultAnswer(job?.result)
  const stop = async () => {
    setBusy(true); setError("")
    try { await stopLongThinkTask(jobId) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "停止失败") }
    finally { setBusy(false) }
  }

  return <section className="mt-5 rounded-[30px] border border-border/70 bg-card/50 p-5 sm:p-7">
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background">{active ? <LoaderCircle className="size-4 animate-spin" /> : <BrainCircuit className="size-4" />}</div>
      <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">{active ? "深度处理中" : job?.status === "completed" ? "已闭环" : job?.status === "cancelled" ? "已停止" : "任务结束"}</h2><div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>轮次 <b className="font-medium text-foreground">{integer(job?.progress?.round)}</b></span><span>API 调用 <b className="font-medium text-foreground">{integer(job?.progress?.apiCalls)}</b></span><span>运行 <b className="font-medium text-foreground">{formatElapsed(elapsed)}</b></span><span>输入 Token <b className="font-medium text-foreground">{nullableInteger(job?.progress?.inputTokens)?.toLocaleString() ?? "未知"}</b></span><span>输出 Token <b className="font-medium text-foreground">{nullableInteger(job?.progress?.outputTokens)?.toLocaleString() ?? "未知"}</b></span></div></div>
      {active && <button disabled={busy} onClick={() => void stop()} className="fluid-press flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"><CircleStop className="size-4" />停止</button>}
    </div>
    {job?.status === "completed" && finalAnswer && <div className="mt-6 whitespace-pre-wrap break-words rounded-2xl border border-border/70 bg-background p-4 text-[15px] leading-7 sm:p-6">{finalAnswer}</div>}
    {job?.status === "failed" && <div className="mt-5 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">任务失败：{job.errorCode ?? "UNKNOWN"}</div>}
    {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
    {!active && <button onClick={onNew} className="fluid-press mt-5 h-11 rounded-xl border border-border px-4 text-sm hover:bg-muted/50">新任务</button>}
  </section>
}

export function LongThinkApp() {
  const { activeJobId, job, selectJob } = useLongThinkJob()
  return <main className="min-h-dvh bg-background text-foreground"><div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6"><Header />{activeJobId ? <Running jobId={activeJobId} job={job} onNew={() => selectJob("")} /> : <Setup onStarted={selectJob} />}</div></main>
}
