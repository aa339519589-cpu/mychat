"use client"

import { useEffect, useState } from "react"
import type { AgentTask, AgentTaskDetail } from "@/lib/agent/types"
import { TaskDetail } from "@/components/agent-tasks/task-detail"
import { TaskList } from "@/components/agent-tasks/task-list"
import { useWorkspaceActions } from "@/components/agent-tasks/use-workspace-actions"

const MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace"

export function AgentTasksPanel({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<AgentTask[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const workspace = useWorkspaceActions(selected, detail?.workspace?.status)

  const fetchList = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/agent/tasks")
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "请求失败")
      setTasks(await response.json())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }

  const selectTask = async (taskId: string) => {
    setSelected(taskId)
    setError(null)
    try {
      const response = await fetch(`/api/agent/tasks/${taskId}`)
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "请求失败")
      setDetail(await response.json())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载详情失败")
    }
  }

  useEffect(() => {
    void fetchList()
  }, [])

  return (
    <div className="h-full" style={{ fontFamily: MONO }}>
      {selected && detail ? (
        <TaskDetail
          detail={detail}
          actions={workspace}
          onBack={() => { setSelected(null); setDetail(null) }}
        />
      ) : (
        <TaskList
          tasks={tasks}
          loading={loading}
          error={error}
          onClose={onClose}
          onRefresh={fetchList}
          onSelect={selectTask}
        />
      )}
    </div>
  )
}
