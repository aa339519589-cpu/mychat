"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowLeft, BrainCircuit, CircleStop, LoaderCircle, Plus, RefreshCw } from "lucide-react"

type Endpoint = {
  id: string
  name: string
  baseUrl: string
  model: string
  outputKind: string
  needsReconnect?: boolean
}

type JobSnapshot = {
  id: string
  status: string
  progress: Record<string, unknown>
  result: unknown
  errorClass: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  terminalAt: string | null
}

type ListedJob = {
  id: string
  status: string
  progress: Record<string, unknown> | null
  result: unknown
  error_code: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  terminal_at: string | null
}

const ACTIVE = new Set(["queued", "leased", "running", "awaiting_input", "cancelling"])
const STORAGE_KEY = "mychat.longThink.activeJob"

function messageOf(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback
  const row = value as Record<string, unknown>
  if (typeof row.error === "string") return row.error
  if (row.error && typeof row.error === "object" && !Array.isArray(row.error)) {
    const error = row.error as Record<string, unknown>
    if (typeof error.message === "string") return error.message
  }
  if (typeof row.message === "string") return row.message
  return fallback
}

async function jsonRequest(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { cache: "no-store", ...init })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(messageOf(body, `请求失败（${response.status}）`))
  return body
}

function integer(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function nullableInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function resultAnswer(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const row = value as Record<string, unknown>
  return typeof row.finalAnswer === "string" ? row.finalAnswer : ""
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (days) return `${days}天 ${hours}小时 ${minutes}分 ${secs}秒`
  if (hours) return `${hours}小时 ${minutes}分 ${secs}秒`
  if (minutes) return `${minutes}分 ${secs}秒`
  return `${secs}秒`
}

export function LongThinkApp() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [endpointChoice, setEndpointChoice] = useState("__new__")
  const [baseUrl, setBaseUrl] = useState("https://api.b.ai/v1")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("deepseek-v4-flash")
  const [problem, setProblem] = useState("")
  const [maxTokens, setMaxTokens] = useState(32768)
  const [minRounds, setMinRounds] = useState(4)
  const [verifyEvery, setVerifyEvery] = useState(6)
  const [activeJobId, setActiveJobId] = useState("")
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [jobs, setJobs] = useState<ListedJob[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [now, setNow] = useState(() => Date.now())

  const loadEndpoints = useCallback(async () => {
    const body = await jsonRequest("/api/endpoints") as { endpoints?: Endpoint[] }
    const chatEndpoints = (body.endpoints ?? []).filter(endpoint => endpoint.outputKind === "chat")
    setEndpoints(chatEndpoints)
  }, [])

  const loadJobs = useCallback(async () => {
    const body = await jsonRequest("/api/long-think/jobs") as { jobs?: ListedJob[] }
    const rows = body.jobs ?? []
    setJobs(rows)
    return rows
  }, [])

  const loadJob = useCallback(async (id: string) => {
    const body = await jsonRequest(`/api/v1/jobs/${encodeURIComponent(id)}`) as { job?: JobSnapshot }
    if (!body.job) throw new Error("任务状态为空")
    setJob(body.job)
    return body.job
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [, rows] = await Promise.all([loadEndpoints(), loadJobs()])
        if (!alive) return
        const remembered = window.localStorage.getItem(STORAGE_KEY) ?? ""
        const candidate = remembered || rows.find(row => ACTIVE.has(row.status))?.id || ""
        if (candidate) {
          setActiveJobId(candidate)
          await loadJob(candidate).catch(() => undefined)
        }
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "初始化失败")
      }
    })()
    return () => { alive = false }
  }, [loadEndpoints, loadJob, loadJobs])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!activeJobId) return
    window.localStorage.setItem(STORAGE_KEY, activeJobId)
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const snapshot = await loadJob(activeJobId)
        if (cancelled) return
        if (ACTIVE.has(snapshot.status)) timer = window.setTimeout(poll, 1500)
        else void loadJobs().catch(() => undefined)
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 3000)
      }
    }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeJobId, loadJob, loadJobs])

  const selectedEndpoint = useMemo(
    () => endpoints.find(endpoint => endpoint.id === endpointChoice) ?? null,
    [endpointChoice, endpoints],
  )

  const createEndpointIfNeeded = async (): Promise<string> => {
    if (selectedEndpoint) return selectedEndpoint.id
    if (!baseUrl.trim() || !model.trim()) throw new Error("请填写 API URL 和模型")
    const body = await jsonRequest("/api/endpoints", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        displayName: model.trim(),
        outputKind: "chat",
        authType: "auto",
      }),
    }) as { endpoint?: Endpoint }
    if (!body.endpoint?.id) throw new Error("模型端点保存失败")
    setEndpoints(previous => [body.endpoint!, ...previous.filter(item => item.id !== body.endpoint!.id)])
    setEndpointChoice(body.endpoint.id)
    setApiKey("")
    return body.endpoint.id
  }

  const start = async () => {
    if (!problem.trim()) { setError("先写问题"); return }
    setBusy(true)
    setError("")
    try {
      const endpointId = await createEndpointIfNeeded()
      const body = await jsonRequest("/api/long-think/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpointId, problem: problem.trim(), maxTokens, minRounds, verifyEvery }),
      }) as { jobId?: string }
      if (!body.jobId) throw new Error("任务创建失败")
      setActiveJobId(body.jobId)
      window.localStorage.setItem(STORAGE_KEY, body.jobId)
      setJob(null)
      await loadJob(body.jobId)
      await loadJobs()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务创建失败")
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    if (!activeJobId || !job || !ACTIVE.has(job.status)) return
    setBusy(true)
    setError("")
    try {
      await jsonRequest(`/api/v1/jobs/${encodeURIComponent(activeJobId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user stopped long-think task" }),
      })
      await loadJob(activeJobId)
      await loadJobs()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "停止失败")
    } finally { setBusy(false) }
  }

  const newTask = () => {
    setActiveJobId("")
    setJob(null)
    setProblem("")
    setError("")
    window.localStorage.removeItem(STORAGE_KEY)
  }

  const active = job && ACTIVE.has(job.status)
  const round = integer(job?.progress?.round)
  const apiCalls = integer(job?.progress?.apiCalls)
  const inputTokens = nullableInteger(job?.progress?.inputTokens)
  const outputTokens = nullableInteger(job?.progress?.outputTokens)
  const started = job?.startedAt ?? job?.createdAt
  const elapsed = started ? (now - Date.parse(started)) / 1000 : 0
  const finalAnswer = resultAnswer(job?.result)

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-16 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
        <header className="flex items-center gap-3 py-3">
          <Link href="/" aria-label="返回 MyChat" className="fluid-press flex size-10 items-center justify-center rounded-full border border-border/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2"><BrainCircuit className="size-4" /><h1 className="font-heading text-xl font-semibold tracking-[-0.02em]">Long Think</h1></div>
            <p className="mt-0.5 text-xs text-muted-foreground">后台连续处理，闭环后再交付最终答案</p>
          </div>
          <button onClick={() => void loadJobs()} className="fluid-press ml-auto flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label="刷新任务">
            <RefreshCw className="size-4" />
          </button>
        </header>

        {!activeJobId ? (
          <section className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div className="rounded-[28px] border border-border/70 bg-card/55 p-4 sm:p-6">
              <label className="mb-2 block text-xs text-muted-foreground">模型连接</label>
              <select value={endpointChoice} onChange={event => setEndpointChoice(event.target.value)} className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none">
                <option value="__new__">新建 API 连接</option>
                {endpoints.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.name} · {endpoint.model}</option>)}
              </select>

              {selectedEndpoint ? (
                <div className="mt-3 rounded-2xl border border-border/60 bg-background/60 p-3 text-sm">
                  <div className="font-medium">{selectedEndpoint.model}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">{selectedEndpoint.baseUrl}</div>
                  {selectedEndpoint.needsReconnect && <div className="mt-2 text-xs text-destructive">该连接需要重新配置凭据</div>}
                </div>
              ) : (
                <div className="mt-3 grid gap-3">
                  <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="API URL" className="h-11 rounded-xl border border-border bg-background px-3 text-sm outline-none" />
                  <input value={apiKey} onChange={event => setApiKey(event.target.value)} type="password" autoComplete="off" placeholder="API Key" className="h-11 rounded-xl border border-border bg-background px-3 text-sm outline-none" />
                  <input value={model} onChange={event => setModel(event.target.value)} placeholder="模型 ID" className="h-11 rounded-xl border border-border bg-background px-3 text-sm outline-none" />
                </div>
              )}

              <label className="mb-2 mt-5 block text-xs text-muted-foreground">问题</label>
              <textarea value={problem} onChange={event => setProblem(event.target.value)} rows={12} placeholder="把需要真正闭环的问题完整写在这里" className="w-full resize-y rounded-2xl border border-border bg-background p-4 text-[15px] leading-6 outline-none" />
              {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
              <button disabled={busy} onClick={() => void start()} className="fluid-press mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-foreground px-5 text-sm font-medium text-background disabled:opacity-50">
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : <BrainCircuit className="size-4" />}
                开始连续处理
              </button>
            </div>

            <aside className="rounded-[28px] border border-border/70 bg-card/40 p-4 sm:p-5">
              <div className="text-xs font-medium text-muted-foreground">参数</div>
              <label className="mt-4 block text-xs text-muted-foreground">单轮最大输出 Token</label>
              <input type="number" min={512} max={262144} value={maxTokens} onChange={event => setMaxTokens(Number(event.target.value) || 32768)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
              <label className="mt-4 block text-xs text-muted-foreground">最少处理轮数</label>
              <input type="number" min={1} value={minRounds} onChange={event => setMinRounds(Number(event.target.value) || 4)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
              <label className="mt-4 block text-xs text-muted-foreground">闭环审查间隔</label>
              <input type="number" min={1} value={verifyEvery} onChange={event => setVerifyEvery(Number(event.target.value) || 6)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" />
              <p className="mt-5 text-xs leading-5 text-muted-foreground">网页关闭后任务仍由后台 Worker 执行。每轮成果先持久化，再进入下一轮。</p>
            </aside>
          </section>
        ) : (
          <section className="mt-5 rounded-[30px] border border-border/70 bg-card/50 p-5 sm:p-7">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                {active ? <LoaderCircle className="size-4 animate-spin" /> : <BrainCircuit className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold">{active ? "深度处理中" : job?.status === "completed" ? "已闭环" : job?.status === "cancelled" ? "已停止" : "任务结束"}</h2>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  <span>轮次 <b className="font-medium text-foreground">{round}</b></span>
                  <span>API 调用 <b className="font-medium text-foreground">{apiCalls}</b></span>
                  <span>运行 <b className="font-medium text-foreground">{formatElapsed(elapsed)}</b></span>
                  <span>输入 Token <b className="font-medium text-foreground">{inputTokens === null ? "未知" : inputTokens.toLocaleString()}</b></span>
                  <span>输出 Token <b className="font-medium text-foreground">{outputTokens === null ? "未知" : outputTokens.toLocaleString()}</b></span>
                </div>
              </div>
              {active && <button disabled={busy} onClick={() => void stop()} className="fluid-press flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:opacity-50"><CircleStop className="size-4" />停止</button>}
            </div>

            {job?.status === "completed" && finalAnswer && <div className="mt-6 whitespace-pre-wrap break-words rounded-2xl border border-border/70 bg-background p-4 text-[15px] leading-7 sm:p-6">{finalAnswer}</div>}
            {job && job.status === "failed" && <div className="mt-5 rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">任务失败：{job.errorCode ?? "UNKNOWN"}</div>}
            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
            {!active && <button onClick={newTask} className="fluid-press mt-5 flex h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm hover:bg-muted/50"><Plus className="size-4" />新任务</button>}
          </section>
        )}

        <section className="mt-8">
          <h2 className="px-1 text-xs font-medium text-muted-foreground">最近任务</h2>
          <div className="mt-2 divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70">
            {jobs.length === 0 ? <div className="p-4 text-sm text-muted-foreground">还没有长期任务</div> : jobs.slice(0, 12).map(item => {
              const p = item.progress ?? {}
              return <button key={item.id} onClick={() => { setActiveJobId(item.id); window.localStorage.setItem(STORAGE_KEY, item.id) }} className="fluid-press flex w-full items-center gap-4 bg-card/30 px-4 py-3 text-left hover:bg-muted/35">
                <div className="min-w-0 flex-1"><div className="truncate text-sm">{item.id.slice(0, 8)}</div><div className="mt-0.5 text-xs text-muted-foreground">轮次 {integer(p.round)} · API {integer(p.apiCalls)}</div></div>
                <span className="text-xs text-muted-foreground">{ACTIVE.has(item.status) ? "处理中" : item.status === "completed" ? "已完成" : item.status === "cancelled" ? "已停止" : "失败"}</span>
              </button>
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
