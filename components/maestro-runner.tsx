"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

type RoundRecord = {
  round: number
  phase: "work" | "review"
  input: string
  output: string
  checkpoint: string
  action: "continue" | "review" | "finish" | "stop"
  startedAt: string
  finishedAt: string
  elapsedMs: number
}

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
  currentInput: string
  currentRoundStartedAt: string | null
  totalElapsedMs: number
  lastOutput: string
  history: RoundRecord[]
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
  if (task.currentRoundStartedAt) return task.phase === "review" ? "独立复核中" : "连续推理中"
  if (task.phase === "review") return "等待独立复核"
  if (task.status === "queued") return "等待启动"
  return "等待下一轮"
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function MaestroRunner() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [activeId, setActiveId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [now, setNow] = useState(() => Date.now())

  const active = useMemo(() => tasks.find(task => task.id === activeId) ?? tasks[0] ?? null, [activeId, tasks])

  const refresh = useCallback(async () => {
    const body = await requestJson("/api/maestro/jobs")
    const next = Array.isArray(body.tasks) ? body.tasks as Task[] : []
    setTasks(next)
    setActiveId(current => current && next.some(task => task.id === current) ? current : next[0]?.id ?? "")
  }, [])

  useEffect(() => {
    void refresh().catch(cause => setError(cause instanceof Error ? cause.message : "任务读取失败"))
    const refreshTimer = window.setInterval(() => { void refresh().catch(() => undefined) }, 1500)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(refreshTimer); window.clearInterval(clockTimer) }
  }, [refresh])

  const stop = async () => {
    if (!active) return
    setBusy(true); setError("")
    try {
      await requestJson(`/api/maestro/jobs/${encodeURIComponent(active.id)}`, { method: "DELETE" })
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "停止失败") }
    finally { setBusy(false) }
  }

  const liveRoundMs = active?.currentRoundStartedAt
    ? Math.max(0, now - Date.parse(active.currentRoundStartedAt))
    : 0
  const liveTotalMs = (active?.totalElapsedMs ?? 0) + liveRoundMs
  const currentRound = active ? active.round + (active.currentRoundStartedAt ? 1 : 0) : 0

  return <main className="min-h-screen bg-background text-foreground">
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border/70 pb-5">
        <div><p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">My Chat</p><h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Maestro Runner</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">这里仅监控任务。新任务直接在 ChatGPT 中 @My che che. 并发送任务内容；内部任务凭证不会显示，也不需要复制。</p></div>
        {active && <div className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground">第 {currentRound} 轮 · {statusText(active)}</div>}
      </header>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="space-y-5">
          {!active && <div className="rounded-3xl border border-border/70 bg-card/50 p-6 text-sm leading-6 text-muted-foreground">还没有 Maestro 任务。请在 ChatGPT 中直接 @My che che. 并发送任务目标。</div>}

          {active && <div className="rounded-3xl border border-border/70 bg-card/50 p-4 sm:p-6">
            <div className="flex items-start justify-between gap-4"><div><div className="text-xs text-muted-foreground">当前任务</div><h2 className="mt-1 text-base font-medium leading-6">{active.objective}</h2></div>{active.status !== "completed" && active.status !== "cancelled" && <button disabled={busy} onClick={() => void stop()} className="shrink-0 rounded-xl border border-border px-3 py-2 text-xs">停止</button>}</div>

            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 text-center">
              <div className="rounded-2xl border border-border/60 p-3"><div className="text-lg font-semibold">{currentRound}</div><div className="text-[11px] text-muted-foreground">当前轮</div></div>
              <div className="rounded-2xl border border-border/60 p-3"><div className="text-lg font-semibold">{active.phase === "review" ? "Review" : active.phase === "done" ? "Done" : "Work"}</div><div className="text-[11px] text-muted-foreground">阶段</div></div>
              <div className="rounded-2xl border border-border/60 p-3"><div className="text-lg font-semibold">{formatMs(liveRoundMs)}</div><div className="text-[11px] text-muted-foreground">本轮墙钟</div></div>
              <div className="rounded-2xl border border-border/60 p-3"><div className="text-lg font-semibold">{formatMs(liveTotalMs)}</div><div className="text-[11px] text-muted-foreground">累计推理墙钟</div></div>
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <div><div className="text-xs font-medium text-muted-foreground">本轮输入</div><div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl border border-border/60 p-4 text-sm leading-6">{active.currentInput || "等待下一轮输入…"}</div></div>
              <div><div className="text-xs font-medium text-muted-foreground">{active.currentRoundStartedAt ? "本轮输出 · 生成中" : active.finalAnswer ? "最终输出" : "最近已完成输出"}</div><div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl border border-border/60 p-4 text-sm leading-6">{active.finalAnswer || active.lastOutput || (active.currentRoundStartedAt ? "本轮正在生成，结束后自动同步。" : "等待输出…")}</div></div>
            </div>

            <div className="mt-5"><div className="text-xs font-medium text-muted-foreground">持久检查点</div><div className="mt-2 whitespace-pre-wrap rounded-2xl border border-border/60 p-4 text-sm leading-6 text-muted-foreground">{active.checkpoint || "暂无检查点"}</div></div>

            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div><div className="text-xs font-medium text-muted-foreground">尚未解决</div><ul className="mt-2 space-y-1 text-sm leading-6">{active.unresolved.length ? active.unresolved.map((item, index) => <li key={`${index}-${item}`}>· {item}</li>) : <li className="text-muted-foreground">无</li>}</ul></div>
              <div><div className="text-xs font-medium text-muted-foreground">下一步</div><ul className="mt-2 space-y-1 text-sm leading-6">{active.nextActions.length ? active.nextActions.map((item, index) => <li key={`${index}-${item}`}>· {item}</li>) : <li className="text-muted-foreground">无</li>}</ul></div>
              <div><div className="text-xs font-medium text-muted-foreground">证据</div><ul className="mt-2 space-y-1 text-sm leading-6">{active.evidence.length ? active.evidence.map((item, index) => <li key={`${index}-${item}`}>· {item}</li>) : <li className="text-muted-foreground">暂无</li>}</ul></div>
            </div>

            <details className="mt-5 rounded-2xl border border-border/60 p-4"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">轮次历史（{active.history.length}）</summary><div className="mt-3 max-h-[32rem] space-y-3 overflow-auto">{active.history.slice().reverse().map(item => <div key={`${item.round}-${item.finishedAt}`} className="rounded-xl border border-border/50 p-3"><div className="flex justify-between gap-3 text-xs"><span>第 {item.round} 轮 · {item.phase === "review" ? "Review" : "Work"}</span><span className="text-muted-foreground">{formatMs(item.elapsedMs)}</span></div><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">输入</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-5">{item.input}</pre></details><details className="mt-2"><summary className="cursor-pointer text-xs text-muted-foreground">输出</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-5">{item.output}</pre></details></div>)}</div></details>

            <div className="mt-4 text-xs text-muted-foreground">服务端状态更新时间：{active.updatedAt}</div>
            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          </div>}
        </section>

        <aside className="rounded-3xl border border-border/70 bg-card/40 p-3 sm:p-4 lg:sticky lg:top-6 lg:self-start">
          <div className="px-2 pb-3 text-xs font-medium text-muted-foreground">任务列表</div>
          <div className="space-y-2">{tasks.length === 0 ? <p className="px-2 py-8 text-center text-xs text-muted-foreground">还没有 Maestro 任务</p> : tasks.map(task => <button key={task.id} onClick={() => setActiveId(task.id)} className={`w-full rounded-2xl border p-3 text-left transition ${task.id === active?.id ? "border-foreground/35 bg-background" : "border-border/60 hover:bg-background/50"}`}><div className="line-clamp-2 text-sm leading-5">{task.objective}</div><div className="mt-2 flex justify-between gap-2 text-[11px] text-muted-foreground"><span>{statusText(task)}</span><span>第 {task.round + (task.currentRoundStartedAt ? 1 : 0)} 轮</span></div></button>)}</div>
        </aside>
      </div>
    </div>
  </main>
}
