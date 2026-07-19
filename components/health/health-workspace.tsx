"use client"

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useEffect, useState, type FormEvent } from "react"
import { ShieldCheck } from "lucide-react"
import { HealthConnectionDialog } from "./health-connection-dialog"
import { HealthHeader, HealthStatusBanner, HealthTabs, ConversationPanel, MetricGrid, PlanPanel, RecordsPanel, TodayPlan, TrendPanel } from "./health-panels"
import { healthMetrics, healthPlan, initialHealthMessages, recoveryTrend, sleepTrend, type HealthMessage, type HealthPlanItem, type HealthTab } from "./health-data"
import { PANEL_SPRING, transitionFor } from "@/components/motion/fluid"

export type HealthWorkspaceProps = {
  open: boolean
  onClose: () => void
}

export function HealthWorkspace({ open, onClose }: HealthWorkspaceProps) {
  const reducedMotion = useReducedMotion()
  const [activeTab, setActiveTab] = useState<HealthTab>("today")
  const [connectionOpen, setConnectionOpen] = useState(false)
  const [planItems, setPlanItems] = useState<HealthPlanItem[]>(healthPlan)
  const [messages, setMessages] = useState<HealthMessage[]>(initialHealthMessages)
  const [query, setQuery] = useState("")
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (connectionOpen) setConnectionOpen(false)
      else onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [connectionOpen, onClose, open])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(null), 3600)
    return () => window.clearTimeout(timer)
  }, [notice])

  function togglePlan(id: string) {
    setPlanItems(items => items.map(item => item.id === id ? { ...item, done: !item.done } : item))
    setNotice("计划已更新，下午签到时我会继续观察。")
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextQuestion = query.trim()
    if (!nextQuestion) return
    const answer = nextQuestion.includes("训练")
      ? "今天建议先做轻到中等强度，控制在能完整说话的程度。完成后告诉我体感，我会根据恢复变化调整下一次安排。"
      : "我会把这个问题和今天的睡眠、恢复趋势放在一起看。先用 0 到 10 告诉我你现在的精力，我再给你更具体的建议。"
    setMessages(items => [...items, { id: `user-${Date.now()}`, role: "user", content: nextQuestion }, { id: `assistant-${Date.now() + 1}`, role: "assistant", content: answer }])
    setQuery("")
  }

  function acknowledgeConnection() {
    setConnectionOpen(false)
    setNotice("已记录授权状态；原生同步完成后会自动替换示例数据。")
  }

  return (
    <AnimatePresence initial={false}>
      {open && <motion.div key="health-workspace" initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.995 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.995 }} transition={transitionFor(reducedMotion, PANEL_SPRING)} className="fixed inset-0 z-[70] flex min-h-0 flex-col overflow-hidden bg-[#F8FAFA] text-[#1B232B] dark:bg-[#151D20] dark:text-[#F3F7FA]" data-testid="health-workspace">
        <HealthHeader onClose={onClose} onOpenRecords={() => setActiveTab("records")} onConnect={() => setConnectionOpen(true)} />
        <HealthTabs active={activeTab} onChange={setActiveTab} />
        <main className="health-scroll min-h-0 flex-1 overflow-y-auto">
          {activeTab === "today" && <TodayView metrics={healthMetrics} items={planItems} messages={messages} query={query} onQueryChange={setQuery} onSubmit={submitQuestion} onTogglePlan={togglePlan} onConnect={() => setConnectionOpen(true)} />}
          {activeTab === "trends" && <TrendPanel sleep={sleepTrend} recovery={recoveryTrend} />}
          {activeTab === "plan" && <PlanPanel items={planItems} onToggle={togglePlan} />}
          {activeTab === "records" && <RecordsPanel onConnect={() => setConnectionOpen(true)} />}
        </main>
        <AnimatePresence initial={false}>{notice && <HealthNotice key="health-notice" message={notice} />}</AnimatePresence>
        <HealthConnectionDialog open={connectionOpen} onClose={() => setConnectionOpen(false)} onAcknowledge={acknowledgeConnection} />
      </motion.div>}
    </AnimatePresence>
  )
}

function TodayView({ metrics, items, messages, query, onQueryChange, onSubmit, onTogglePlan, onConnect }: { metrics: typeof healthMetrics; items: HealthPlanItem[]; messages: HealthMessage[]; query: string; onQueryChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onTogglePlan: (id: string) => void; onConnect: () => void }) {
  return <><HealthStatusBanner onConnect={onConnect} /><MetricGrid metrics={metrics} /><TodayPlan items={items} onToggle={onTogglePlan} /><ConversationPanel messages={messages} value={query} onChange={onQueryChange} onSubmit={onSubmit} /><div className="mx-auto max-w-[1240px] px-4 py-5 sm:px-7 sm:py-7"><div className="flex items-start gap-3 rounded-xl border border-[#D7E0E4] bg-white/65 px-4 py-4 dark:border-white/10 dark:bg-[#202A2E]"><ShieldIcon /><p className="text-[11px] leading-5 text-[#718087] dark:text-[#AEBBC5]">今天的建议来自示例数据。连接 Apple 健康后，我会先学习你的个人节奏，再逐步减少泛化提醒。</p></div></div></>
}

function ShieldIcon() {
  return <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-[#E8F4F1] text-[#0F766E] dark:bg-[#163A37] dark:text-[#8BE2D0]"><ShieldCheck className="size-3.5" aria-hidden="true" /></span>
}

function HealthNotice({ message }: { message: string }) {
  return <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} className="pointer-events-none fixed inset-x-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[120] mx-auto max-w-md rounded-xl border border-[#B9D8D1] bg-[#F3F8F7] px-4 py-3 text-center text-[12px] font-semibold text-[#45625E] shadow-[0_12px_30px_rgb(15_58_55/16%)] dark:border-[#39766C] dark:bg-[#172A29] dark:text-[#B8CDCA]">{message}</motion.div>
}
