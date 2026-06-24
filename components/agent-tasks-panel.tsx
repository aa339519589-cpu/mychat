"use client"

import { useEffect, useState } from "react"
import { X, ChevronLeft, Loader2, RefreshCw, Square } from "lucide-react"
import type { AgentTask, AgentTaskDetail } from "@/lib/agent/types"
import { cn } from "@/lib/utils"

const MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace"
const ACCENT = "var(--code-accent)"

const STATUS_LABEL: Record<string, string> = {
  pending: "等待中",
  running: "运行中",
  waiting_confirm: "等待确认",
  cancelled: "已取消",
  failed: "失败",
  completed: "完成",
  paused: "已暂停",
}

const STATUS_COLOR: Record<string, string> = {
  pending: "text-muted-foreground",
  running: "text-blue-400",
  waiting_confirm: "text-yellow-400",
  cancelled: "text-muted-foreground/60",
  failed: "text-red-400",
  completed: "text-green-400",
  paused: "text-orange-400",
}

// ── 任务列表 ──

export function AgentTasksPanel({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<AgentTask[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchList = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/agent/tasks")
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "请求失败")
      setTasks(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }

  const fetchDetail = async (taskId: string) => {
    setError(null)
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "请求失败")
      setDetail(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载详情失败")
    }
  }

  useEffect(() => { fetchList() }, [])

  // Detail view
  if (selected && detail) {
    return (
      <div className="flex flex-col h-full" style={{ fontFamily: MONO }}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <button onClick={() => { setSelected(null); setDetail(null) }} className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-[12px] font-medium text-foreground truncate flex-1">{detail.goal.slice(0, 60)}</span>
          <span className={cn("text-[11px]", STATUS_COLOR[detail.status] ?? "text-muted-foreground")}>
            {STATUS_LABEL[detail.status] ?? detail.status}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* Steps */}
          {detail.steps.length > 0 && (
            <div>
              <p className="text-[11px] text-muted-foreground mb-1.5">执行步骤</p>
              <div className="space-y-0.5">
                {detail.steps.map(s => (
                  <div key={s.id} className="flex items-start gap-2 text-[11px]">
                    <span className={cn("shrink-0 mt-0.5", STATUS_COLOR[s.kind === "error" ? "failed" : "completed"])}>·</span>
                    <span className="text-muted-foreground">{s.label || s.kind}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tool calls */}
          {detail.toolCalls.length > 0 && (
            <div>
              <p className="text-[11px] text-muted-foreground mb-1.5">工具调用</p>
              <div className="space-y-1">
                {detail.toolCalls.map(tc => (
                  <div key={tc.id} className="flex items-center gap-2 text-[11px] rounded bg-secondary/30 px-2 py-1">
                    <span className={cn("shrink-0", STATUS_COLOR[tc.status === "success" ? "completed" : tc.status === "error" ? "failed" : "running"])}>·</span>
                    <span className="font-medium text-foreground/80">{tc.toolName}</span>
                    {tc.durationMs != null && <span className="text-muted-foreground/60 ml-auto">{tc.durationMs}ms</span>}
                    {tc.error && <span className="text-red-400 truncate ml-2">{tc.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Workspace */}
          {detail.workspace && (
            <div>
              <p className="text-[11px] text-muted-foreground mb-1">Workspace</p>
              <div className="text-[11px] rounded bg-secondary/30 px-2 py-1 text-muted-foreground">
                {detail.workspace.repo} @ {detail.workspace.branch}
              </div>
            </div>
          )}

          {/* Artifacts */}
          {detail.artifacts.length > 0 && (
            <div>
              <p className="text-[11px] text-muted-foreground mb-1.5">产物</p>
              <div className="space-y-1">
                {detail.artifacts.map(a => (
                  <div key={a.id} className="text-[11px] rounded bg-secondary/30 px-2 py-1 text-muted-foreground">
                    [{a.kind}] {a.title || a.id}
                    {a.url && <a href={a.url} target="_blank" rel="noreferrer" className="ml-2 underline" style={{ color: ACCENT }}>打开</a>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="flex flex-col h-full" style={{ fontFamily: MONO }}>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <span className="text-[12px] font-medium text-foreground">Agent Tasks</span>
        <button onClick={fetchList} className="ml-auto text-muted-foreground hover:text-foreground">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && tasks === null && (
          <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
        )}
        {error && (
          <p className="px-4 py-3 text-[12px] text-red-400">{error}</p>
        )}
        {tasks && tasks.length === 0 && (
          <p className="px-4 py-8 text-center text-[12px] text-muted-foreground">暂无 Agent 任务</p>
        )}
        {tasks?.map(t => (
          <button
            key={t.id}
            onClick={() => { setSelected(t.id); fetchDetail(t.id) }}
            className="w-full text-left px-4 py-2.5 border-b border-border/30 transition-colors hover:bg-secondary/40"
          >
            <div className="flex items-center gap-2">
              <span className={cn("shrink-0 text-[10px]", STATUS_COLOR[t.status])}>
                {STATUS_LABEL[t.status] ?? t.status}
              </span>
              {t.repo && <span className="text-[10px] text-muted-foreground/70">{t.repo}</span>}
              <span className="text-[10px] text-muted-foreground/50 ml-auto">
                {new Date(t.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <p className="text-[12px] text-foreground/80 truncate mt-0.5">{t.goal}</p>
            {t.error && <p className="text-[11px] text-red-400/80 truncate mt-0.5">{t.error}</p>}
          </button>
        ))}
      </div>
    </div>
  )
}
