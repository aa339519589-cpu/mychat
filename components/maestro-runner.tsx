"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

type Task = {
  id: string
  objective: string
  status: string
  round: number
  phase: "work" | "review" | "done"
  maxRounds: number
  checkpoint: string
  unresolved: string[]
  nextActions: string[]
  evidence: string[]
  candidateAnswer: string
  finalAnswer: string
  lastAction: "queued" | "continue" | "review" | "finish" | "stop"
  lastReportedAt: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

async function requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { cache: "no-store", ...init })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `请求失败（${response.status}）`)
  return body ?? {}
}

function statusText(task: Task): string {
  if (task.status === "completed") return "已完成"
  if (task.status === "cancelled") return "已停止"
  if (task.status === "failed") return "失败"
  if (task.phase === "review") return "独立复核"
  if (task.status === "queued") return "正在启动 ChatGPT"
  return "连续推理中"
}

export function MaestroRunner() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [activeId, setActiveId] = useState("")
  const [objective, setObjective] = useState("")
  const [maxRounds, setMaxRounds] = useState("10000")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const active = useMemo(() => tasks.find(task => task.id === activeId) ?? tasks[0] ?? null, [activeId, tasks])

  const refresh = useCallback(async () => {
    const body = await requestJson("/api/maestro/jobs")
    const next = Array.isArray(body.tasks) ? body.tasks as Task[] : []
    setTasks(next)
    setActiveId(current => current && next.some(task => task.id === current) ? current : next[0]?.id ?? "")
  }, [])

  useEffect(() => {
    void refresh().catch(cause => setError(cause instanceof Error ? cause.message : "任务读取失败"))
    const timer = window.setInterval(() => { void refresh().catch(() => undefined) }, 1500)
    return () => window.clearInterval(timer)
  }, [refresh])

  const create = async () => {
    const chatWindow = window.open("about:blank", "_blank")
    setBusy(true); setError("")
    try {
      if (chatWindow) {
        chatWindow.document.title = "正在启动 ChatGPT…"
        chatWindow.document.body.textContent = "正在启动 ChatGPT…"
      }
      const rounds = Number(maxRounds)
      if (!Number.isSafeInteger(rounds) || rounds < 2 || rounds > 100000) throw new Error("最大轮数必须是 2 到 100000")
      const body = await requestJson("/api/maestro/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective, maxRounds: rounds }),
      })
      const task = body.task as Task | undefined
      const launchUrl = typeof body.launchUrl === "string" ? body.launchUrl : ""
      if (!task?.id || !launchUrl) throw new Error("Maestro 任务创建结果无效")
      setActiveId(task.id)
      setObjective("")
      await refresh()
      if (chatWindow && !chatWindow.closed) chatWindow.location.replace(launchUrl)
      else window.location.assign(launchUrl)
    } catch (cause) {
      if (chatWindow && !chatWindow.closed) chatWindow.close()
      setError(cause instanceof Error ? cause.message : "任务创建失败")
    } finally { setBusy(false) }
  }

  const stop = async () => {
    if (!active) return
    setBusy(true); setError("")
    try {
      await requestJson(`/api/maestro/jobs/${encodeURIComponent(active.id)}`, { method: "DELETE" })
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "停止失败") }
    finally { setBusy(false) }
  }

  return <main className="min-h-screen bg-background text-foreground">
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border/70 pb-5">
        <div><p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">My Chat</p><h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Maestro Runner</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">My Chat 创建任务后直接启动 ChatGPT；每一轮真正结束后自动开启下一轮，独立复核通过才停止。</p></div>
        {active && <div className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">第 {active.round} 轮 · {statusText(active)}</div>}
      </header>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-5">
          <div className="rounded-3xl border border-border/70 bg-card/50 p-4 sm:p-6">
            <label className="text-xs font-medium text-muted-foreground">新任务</label>
            <textarea value={objective} onChange={event => setObjective(event.target.value)} rows={10} placeholder="把需要持续多轮闭环的问题完整写在这里" className="mt-2 w-full resize-y rounded-2xl border border-border bg-background p-4 text-sm leading-6 outline-none" />
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted-foreground">最大轮数<input value={maxRounds} onChange={event => setMaxRounds(event.target.value)} type="number" min={2} max={100000} className="mt-1 block h-10 w-36 rounded-xl border border-border bg-background px-3 text-sm text-foreground" /></label>
              <button disabled={busy || !objective.trim()} onClick={() => void create()} className="h-10 rounded-xl bg-foreground px-5 text-sm font-medium text-background disabled:opacity-40">{busy ? "正在启动…" : "创建并启动 ChatGPT"}</button>
            </div>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">不需要复制启动指令，也不需要输入任何启动码。</p>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          </div>

          {active && <div className="rounded-3xl border border-border/70 bg-card/50 p-4 sm:p-6">
            <div className="flex items-start justify-between gap-4"><div><div className="text-xs text-muted-foreground">当前任务</div><h2 className="mt-1 text-base font-medium leading-6">{active.objective}</h2></div>{active.status !== "completed" && active.status !== "cancelled" && <button disabled={busy} onClick={() => void stop()} className="shrink-0 rounded-xl border border-border px-3 py-2 text-xs">停止</button>}</div>
            <div className="mt-5 grid grid-cols-3 gap-2 text-center"><div className="rounded-2xl border border-border/60 p-3"><div className="text-lg font-semibold">{active.round}</div><div className="text-[11px] text-muted-foreground">已完成轮次</div></div><div className="rounded-2xl border border-border/60 p-3"><div className="text-lg font-semibold">{active.phase === "review" ? "Review" : active.phase === "done" ? "Done" : "Work"}</div><div className="text-[11px] text-muted-foreground">阶段</div></div><div className="rounded-2xl border border-border/60 p-3"><div className="text-lg font-semibold">{active.unresolved.length}</div><div className="text-[11px] text-muted-foreground">未闭环项</div></div></div>
            {active.finalAnswer ? <div className="mt-5"><div className="text-xs font-medium text-muted-foreground">最终结果</div><div className="mt-2 whitespace-pre-wrap rounded-2xl border border-border/60 p-4 text-sm leading-6">{active.finalAnswer}</div></div> : <><div className="mt-5"><div className="text-xs font-medium text-muted-foreground">持久检查点</div><div className="mt-2 whitespace-pre-wrap rounded-2xl border border-border/60 p-4 text-sm leading-6 text-muted-foreground">{active.checkpoint || "等待第一轮检查点…"}</div></div>{active.unresolved.length > 0 && <div className="mt-4"><div className="text-xs font-medium text-muted-foreground">尚未解决</div><ul className="mt-2 space-y-1 text-sm leading-6">{active.unresolved.map((item, index) => <li key={`${index}-${item}`}>· {item}</li>)}</ul></div>}</>}
          </div>}
        </section>

        <aside className="rounded-3xl border border-border/70 bg-card/40 p-3 sm:p-4 lg:sticky lg:top-6 lg:self-start">
          <div className="px-2 pb-3 text-xs font-medium text-muted-foreground">任务列表</div>
          <div className="space-y-2">{tasks.length === 0 ? <p className="px-2 py-8 text-center text-xs text-muted-foreground">还没有 Maestro 任务</p> : tasks.map(task => <button key={task.id} onClick={() => setActiveId(task.id)} className={`w-full rounded-2xl border p-3 text-left transition ${task.id === active?.id ? "border-foreground/35 bg-background" : "border-border/60 hover:bg-background/50"}`}><div className="line-clamp-2 text-sm leading-5">{task.objective}</div><div className="mt-2 flex justify-between gap-2 text-[11px] text-muted-foreground"><span>{statusText(task)}</span><span>第 {task.round} 轮</span></div></button>)}</div>
        </aside>
      </div>
    </div>
  </main>
}
