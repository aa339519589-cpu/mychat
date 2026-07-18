"use client"

import { useEffect, useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import type { AgentTask, AgentTaskDetail } from "@/lib/agent/types"
import { TaskDetail } from "@/components/agent-tasks/task-detail"
import { TaskList } from "@/components/agent-tasks/task-list"
import { useWorkspaceActions } from "@/components/agent-tasks/use-workspace-actions"
import { PANEL_SPRING, transitionFor } from "@/components/motion/fluid"

const MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace"

export function AgentTasksPanel({
  onClose,
  showHeaderClose = true,
}: {
  onClose: () => void
  showHeaderClose?: boolean
}) {
  const [tasks, setTasks] = useState<AgentTask[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const workspace = useWorkspaceActions(selected, detail?.workspace?.status)
  const reducedMotion = useReducedMotion()

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
    <div className="relative h-full overflow-hidden" style={{ fontFamily: MONO }}>
      <AnimatePresence initial={false} mode="popLayout">
      {selected && detail ? (
        <motion.div
          key="task-detail"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 28 }}
          transition={transitionFor(reducedMotion, PANEL_SPRING)}
          className="absolute inset-0"
        ><TaskDetail
          detail={detail}
          actions={workspace}
          onBack={() => { setSelected(null); setDetail(null) }}
        /></motion.div>
      ) : (
        <motion.div
          key="task-list"
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -20 }}
          transition={transitionFor(reducedMotion, PANEL_SPRING)}
          className="absolute inset-0"
        ><TaskList
          tasks={tasks}
          loading={loading}
          error={error}
          onClose={showHeaderClose ? onClose : undefined}
          onRefresh={fetchList}
          onSelect={selectTask}
        /></motion.div>
      )}
      </AnimatePresence>
    </div>
  )
}
