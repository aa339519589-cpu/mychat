"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, BrainCircuit, Copy, ExternalLink, LoaderCircle, Square, Plus } from "lucide-react"

type JobSnapshot = {
  id: string
  status: string
  progress?: Record<string, unknown>
  result?: unknown
  errorCode?: string | null
}

const ACTIVE = new Set(["queued", "leased", "running", "awaiting_input", "cancelling"])
const STORAGE_KEY = "mychat:chatgpt-subscription-long-think"
const BRIDGE_SOURCE = "https://github.com/aa339519589-cpu/mychat/tree/feature/chatgpt-subscription-long-think/browser/chatgpt-subscription-bridge"

async function jsonRequest(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, cache: "no-store" })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const error = body.error && typeof body.error === "object" && !Array.isArray(body.error)
      ? body.error as Record<string, unknown>
      : body
    throw new Error(typeof error.message === "string" ? error.message : `HTTP ${response.status}`)
  }
  return body
}

function integer(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数`)
  return parsed
}

function resultAnswer(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const answer = (value as Record<string, unknown>).answer
  return typeof answer === "string" ? answer : ""
}

function progressText(progress: Record<string, unknown> | undefined, key: string): string {
  const value = progress?.[key]
  return typeof value === "string" ? value : ""
}

function progressList(progress: Record<string, unknown> | undefined, key: string): string[] {
  const value = progress?.[key]
  return Array.isArray(value) ? value.filter(item => typeof item === "string") as string[] : []
}

export function ChatGptSubscriptionLongThink() {
  const [problem, setProblem] = useState("")
  const [maxTokens, setMaxTokens] = useState("32768")
  const [minRounds, setMinRounds] = useState("4")
  const [verifyEvery, setVerifyEvery] = useState("6")
  const [jobId, setJobId] = useState("")
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [pairToken, setPairToken] = useState("")
  const [pairExpiry, setPairExpiry] = useState("")
  const [busy, setBusy] = useState(false)
  const [pairBusy, setPairBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    const remembered = window.localStorage.getItem(STORAGE_KEY) ?? ""
    if (remembered) setJobId(remembered)
  }, [])

  const refresh = useCallback(async () => {
    if (!jobId) return
    const body = await jsonRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}`) as { job?: JobSnapshot }
    if (body.job) setJob(body.job)
  }, [jobId])

  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const body = await jsonRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}`) as { job?: JobSnapshot }
        if (cancelled || !body.job) return
        setJob(body.job)
        if (ACTIVE.has(body.job.status)) timer = window.setTimeout(poll, 1500)
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "任务状态读取失败")
          timer = window.setTimeout(poll, 3000)
        }
      }
    }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [jobId])

  const createPair = async () => {
    setPairBusy(true); setError("")
    try {
      const body = await jsonRequest("/api/chatgpt-bridge/pair", { method: "POST" })
      setPairToken(typeof body.token === "string" ? body.token : "")
      setPairExpiry(typeof body.expiresAt === "string" ? body.expiresAt : "")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "配对令牌创建失败") }
    finally { setPairBusy(false) }
  }

  const copyPair = async () => {
    if (!pairToken) return
    await navigator.clipboard.writeText(pairToken)
  }

  const start = async () => {
    setBusy(true); setError("")
    try {
      const body = await jsonRequest("/api/chatgpt-long/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          problem: problem.trim(),
          maxTokens: integer(maxTokens, "单轮目标 Token", 512, 262144),
          minRounds: integer(minRounds, "最少处理轮数", 1, 100000),
          verifyEvery: integer(verifyEvery, "闭环审查间隔", 1, 10000),
        }),
      })
      const id = typeof body.jobId === "string" ? body.jobId : ""
      if (!id) throw new Error("任务创建失败")
      window.localStorage.setItem(STORAGE_KEY, id)
      setJobId(id)
      setJob(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "任务创建失败") }
    finally { setBusy(false) }
  }

  const stop = async () => {
    if (!jobId) return
    setBusy(true); setError("")
    try {
      await jsonRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user stopped ChatGPT subscription long-think" }),
      })
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "停止失败") }
    finally { setBusy(false) }
  }

  const newTask = () => {
    window.localStorage.removeItem(STORAGE_KEY)
    setJobId("")
    setJob(null)
    setProblem("")
    setError("")
  }

  const answer = resultAnswer(job?.result)
  const round = typeof job?.progress?.round === "number" ? job.progress.round : 0
  const phase = progressText(job?.progress, "phase")
  const summary = progressText(job?.progress, "progressSummary")
  const unresolved = progressList(job?.progress, "unresolved")
  const nextActions = progressList(job?.progress, "nextActions")
  const stream = progressText(job?.progress, "providerStreamText")

  return <main className="h-dvh w-full overflow-y-auto overscroll-y-contain touch-pan-y bg-background text-foreground [-webkit-overflow-scrolling:touch]">
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 pb-[max(4rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
      <header className="flex items-center gap-3 py-3">
        <Link href="/long-think" aria-label="返回 Long Think" className="fluid-press flex size-10 items-center justify-center rounded-full border border-border/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground"><ArrowLeft className="size-4" /></Link>
        <div className="min-w-0"><div className="flex items-center gap-2"><BrainCircuit className="size-4" /><h1 className="truncate font-heading text-xl font-semibold tracking-[-0.02em]">ChatGPT Subscription Long Think</h1></div><p className="mt-0.5 text-xs text-muted-foreground">使用已登录的 ChatGPT 网页会话连续推断，不需要 API Key</p></div>
      </header>

      {!jobId ? <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="rounded-[28px] border border-border/70 bg-card/55 p-4 sm:p-6">
          <label className="mb-2 block text-xs text-muted-foreground">问题</label>
          <textarea value={problem} onChange={event => setProblem(event.target.value)} rows={14} placeholder="把需要持续处理直到闭环的问题写在这里" className="w-full resize-y rounded-2xl border border-border bg-background p-4 text-[15px] leading-6 outline-none" />
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          <button disabled={busy || !problem.trim()} onClick={() => void start()} className="fluid-press mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-foreground px-5 text-sm font-medium text-background disabled:opacity-50">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <BrainCircuit className="size-4" />}开始 ChatGPT 连续处理</button>
        </section>

        <aside className="grid content-start gap-4">
          <section className="rounded-[28px] border border-border/70 bg-card/40 p-4 sm:p-5">
            <div className="text-xs font-medium text-muted-foreground">ChatGPT 网页桥</div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">浏览器桥只使用 chatgpt.com 当前登录会话。My Chat 不保存 ChatGPT Cookie。</p>
            <a href={BRIDGE_SOURCE} target="_blank" rel="noreferrer" className="fluid-press mt-3 flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-background px-3 text-xs"><ExternalLink className="size-3.5" />打开桥接扩展目录</a>
            <button disabled={pairBusy} onClick={() => void createPair()} className="fluid-press mt-2 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-foreground px-3 text-xs text-background disabled:opacity-50">{pairBusy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}生成配对令牌</button>
            {pairToken && <div className="mt-3"><textarea readOnly value={pairToken} rows={4} className="w-full resize-none rounded-xl border border-border bg-background p-2 font-mono text-[10px] leading-4" /><button onClick={() => void copyPair()} className="fluid-press mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-border bg-background text-xs"><Copy className="size-3.5" />复制令牌</button>{pairExpiry && <p className="mt-2 break-all text-[10px] text-muted-foreground">有效至 {pairExpiry}</p>}</div>}
          </section>
          <section className="rounded-[28px] border border-border/70 bg-card/40 p-4 sm:p-5">
            <div className="text-xs font-medium text-muted-foreground">参数</div>
            <label className="mt-4 block text-xs text-muted-foreground">单轮目标 Token</label><input type="number" inputMode="numeric" value={maxTokens} onChange={event => setMaxTokens(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
            <label className="mt-4 block text-xs text-muted-foreground">最少处理轮数</label><input type="number" inputMode="numeric" value={minRounds} onChange={event => setMinRounds(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
            <label className="mt-4 block text-xs text-muted-foreground">闭环审查间隔</label><input type="number" inputMode="numeric" value={verifyEvery} onChange={event => setVerifyEvery(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
          </section>
        </aside>
      </div> : <section className="mt-5 rounded-[28px] border border-border/70 bg-card/55 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs text-muted-foreground">{job?.status ?? "载入中"}</div><div className="mt-1 text-sm font-medium">第 {round} 轮 · {phase || "等待状态"}</div></div><div className="flex gap-2"><button onClick={newTask} className="fluid-press flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs"><Plus className="size-3.5" />新任务</button>{job && ACTIVE.has(job.status) && <button disabled={busy} onClick={() => void stop()} className="fluid-press flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-xs"><Square className="size-3.5" />停止</button>}</div></div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        {summary && <div className="mt-5"><div className="text-xs text-muted-foreground">当前进展</div><p className="mt-2 whitespace-pre-wrap text-sm leading-6">{summary}</p></div>}
        {unresolved.length > 0 && <div className="mt-5"><div className="text-xs text-muted-foreground">未闭环</div><ul className="mt-2 space-y-1 text-sm leading-6">{unresolved.map((item, index) => <li key={index}>· {item}</li>)}</ul></div>}
        {nextActions.length > 0 && <div className="mt-5"><div className="text-xs text-muted-foreground">下一步</div><ul className="mt-2 space-y-1 text-sm leading-6">{nextActions.map((item, index) => <li key={index}>· {item}</li>)}</ul></div>}
        {stream && !answer && <div className="mt-5"><div className="text-xs text-muted-foreground">最近一次 ChatGPT 输出</div><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-2xl border border-border bg-background p-4 text-xs leading-5">{stream}</pre></div>}
        {answer && <div className="mt-5"><div className="text-xs text-muted-foreground">最终答案</div><div className="mt-2 whitespace-pre-wrap rounded-2xl border border-border bg-background p-4 text-sm leading-6">{answer}</div></div>}
        {job?.status === "failed" && <p className="mt-5 text-sm text-destructive">任务失败：{job.errorCode ?? "unknown"}</p>}
      </section>}
    </div>
  </main>
}
