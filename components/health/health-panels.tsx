"use client"

import { Activity, ArrowUpRight, Check, ChevronRight, CircleHelp, Clock3, HeartPulse, Moon, ShieldCheck, Sparkles, SunMedium, Watch, Zap } from "lucide-react"
import type { FormEvent, ReactNode } from "react"
import type { HealthMessage, HealthMetric, HealthPlanItem, HealthTone } from "./health-data"
import { cn } from "@/lib/utils"

const toneStyles: Record<HealthTone, { text: string; surface: string; marker: string }> = {
  positive: { text: "text-[#0F766E] dark:text-[#79D0BE]", surface: "bg-[#E8F4F1] dark:bg-[#163A37]", marker: "bg-[#0F766E]" },
  neutral: { text: "text-[#3564A8] dark:text-[#8DB6F1]", surface: "bg-[#EAF0F8] dark:bg-[#1E3049]", marker: "bg-[#3564A8]" },
  attention: { text: "text-[#A16207] dark:text-[#E9B65D]", surface: "bg-[#FFF4D9] dark:bg-[#44361B]", marker: "bg-[#C58A24]" },
}

export function HealthHeader({ onClose, onOpenRecords, onConnect }: { onClose: () => void; onOpenRecords: () => void; onConnect: () => void }) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-[#D7E0E4] bg-[#F8FAFA]/92 px-4 pb-3 pt-[max(0.7rem,env(safe-area-inset-top))] backdrop-blur-xl dark:border-white/10 dark:bg-[#151D20]/92 sm:px-7 sm:pb-4">
      <button type="button" onClick={onClose} aria-label="返回聊天" className="fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-full text-[#52616C] hover:bg-[#E7EFF1] hover:text-[#1B232B] dark:text-[#B7C5C9] dark:hover:bg-white/10 dark:hover:text-white">
        <ChevronRight className="size-5 rotate-180" aria-hidden="true" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <HeartPulse className="size-[18px] text-[#0F766E] dark:text-[#79D0BE]" aria-hidden="true" />
          <h1 className="truncate text-[17px] font-semibold tracking-tight text-[#1B232B] dark:text-[#F3F7FA]">健康</h1>
          <span className="rounded-full bg-[#FFF4D9] px-2 py-0.5 text-[10px] font-semibold text-[#8A5A05] dark:bg-[#44361B] dark:text-[#F5CA77]">示例数据</span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-[#6D7C83] dark:text-[#AEBBC5]">正在学习你的个人基线 · 最近同步 09:42</p>
      </div>
      <button type="button" onClick={onConnect} className="fluid-press hidden min-h-11 items-center gap-2 rounded-xl border border-[#B9D8D1] bg-[#F2FAF7] px-3 text-[12px] font-semibold text-[#0F766E] hover:bg-[#E6F5F0] dark:border-[#39766C] dark:bg-[#163A37] dark:text-[#9BE4D3] sm:flex">
        <Watch className="size-4" aria-hidden="true" />
        连接 Apple 健康
      </button>
      <button type="button" onClick={onOpenRecords} aria-label="打开健康档案" className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full text-[#52616C] hover:bg-[#E7EFF1] hover:text-[#1B232B] dark:text-[#B7C5C9] dark:hover:bg-white/10 dark:hover:text-white sm:hidden">
        <ShieldCheck className="size-[18px]" aria-hidden="true" />
      </button>
    </header>
  )
}

export function HealthTabs({ active, onChange }: { active: string; onChange: (tab: "today" | "trends" | "plan" | "records") => void }) {
  const tabs = [
    ["today", "今天"],
    ["trends", "趋势"],
    ["plan", "计划"],
    ["records", "档案"],
  ] as const
  return (
    <nav aria-label="健康视图" className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#D7E0E4] bg-[#F8FAFA] px-4 dark:border-white/10 dark:bg-[#151D20] sm:px-7">
      {tabs.map(([id, label]) => (
        <button key={id} type="button" onClick={() => onChange(id)} aria-current={active === id ? "page" : undefined} className={cn("relative min-h-12 shrink-0 px-3 text-[13px] font-semibold transition-colors", active === id ? "text-[#0F766E] dark:text-[#8BE2D0]" : "text-[#718087] hover:text-[#1B232B] dark:text-[#9BAAB0] dark:hover:text-white")}>
          {label}
          {active === id && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[#0F766E] dark:bg-[#8BE2D0]" />}
        </button>
      ))}
    </nav>
  )
}

export function HealthStatusBanner({ onConnect }: { onConnect: () => void }) {
  return (
    <section className="border-b border-[#D7E0E4] bg-[#F3F8F7] px-4 py-4 dark:border-white/10 dark:bg-[#172A29] sm:px-7 sm:py-5" aria-labelledby="health-status-title">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0F766E] dark:text-[#8BE2D0]">
            <span className="flex size-5 items-center justify-center rounded-full bg-[#D9EFE9] dark:bg-[#23534A]"><SunMedium className="size-3.5" aria-hidden="true" /></span>
            今日判断 · 现在
          </div>
          <h2 id="health-status-title" className="text-[24px] font-semibold leading-tight tracking-tight text-[#173239] dark:text-[#F1FAF8] sm:text-[28px]">今天恢复偏低，适合把强度降一级。</h2>
          <p className="mt-2 max-w-xl text-[13px] leading-6 text-[#51676D] dark:text-[#B8CDCA]">睡眠时长、静息心率和 HRV 都偏离你的个人基线。它们更像是身体在提醒你留出恢复空间，而不是需要担心的单一结论。</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <span className="inline-flex min-h-9 items-center gap-2 rounded-full border border-[#C9DDDA] bg-white/75 px-3 text-[11px] text-[#45625E] dark:border-[#39766C] dark:bg-[#1C3A37] dark:text-[#BFE8DF]"><CircleHelp className="size-3.5" aria-hidden="true" />基于 30 天个人基线</span>
          <button type="button" onClick={onConnect} className="fluid-press inline-flex min-h-11 items-center gap-2 rounded-xl bg-[#0F766E] px-3.5 text-[12px] font-semibold text-white shadow-[0_6px_16px_rgb(15_118_110/18%)] hover:bg-[#0B625C]">连接真实数据<ArrowUpRight className="size-3.5" aria-hidden="true" /></button>
        </div>
      </div>
    </section>
  )
}

export function MetricGrid({ metrics }: { metrics: HealthMetric[] }) {
  return (
    <section aria-labelledby="health-signals-title" className="border-b border-[#D7E0E4] px-4 py-5 dark:border-white/10 sm:px-7 sm:py-6">
      <div className="mx-auto max-w-[1240px]">
        <div className="mb-3 flex items-end justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#718087] dark:text-[#AEBBC5]">身体信号</p><h3 id="health-signals-title" className="mt-1 text-[17px] font-semibold text-[#1B232B] dark:text-[#F3F7FA]">值得留意的四个变化</h3></div><p className="text-right text-[11px] text-[#718087] dark:text-[#AEBBC5]">数据仅作健康管理参考</p></div>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {metrics.map(metric => <MetricItem key={metric.id} metric={metric} />)}
        </div>
      </div>
    </section>
  )
}

function MetricItem({ metric }: { metric: HealthMetric }) {
  const style = toneStyles[metric.tone]
  return (
    <article className="min-h-[132px] rounded-xl border border-[#D7E0E4] bg-white/80 p-3.5 dark:border-white/10 dark:bg-[#202A2E] sm:min-h-[148px] sm:p-4">
      <div className="flex items-center justify-between gap-2"><p className="text-[12px] font-semibold text-[#52616C] dark:text-[#B7C5C9]">{metric.label}</p><span className={cn("size-2 rounded-full", style.marker)} aria-label={metric.tone === "attention" ? "需要关注" : "稳定"} /></div>
      <p className="mt-3 text-[21px] font-semibold tracking-tight text-[#1B232B] dark:text-[#F3F7FA]">{metric.value}<span className="ml-1 text-[11px] font-medium text-[#718087] dark:text-[#AEBBC5]">{metric.unit}</span></p>
      <p className={cn("mt-2 text-[11px] font-semibold", style.text)}>{metric.delta}</p>
      <p className="mt-1 text-[10px] leading-4 text-[#7D8A90] dark:text-[#99A9AE]">{metric.detail}</p>
    </article>
  )
}

export function TodayPlan({ items, onToggle }: { items: HealthPlanItem[]; onToggle: (id: string) => void }) {
  return (
    <section aria-labelledby="today-plan-title" className="border-b border-[#D7E0E4] px-4 py-5 dark:border-white/10 sm:px-7 sm:py-6">
      <div className="mx-auto max-w-[1240px]"><div className="mb-3 flex items-end justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#718087] dark:text-[#AEBBC5]">接下来</p><h3 id="today-plan-title" className="mt-1 text-[17px] font-semibold text-[#1B232B] dark:text-[#F3F7FA]">今天的三个小动作</h3></div><span className="text-[11px] text-[#718087] dark:text-[#AEBBC5]">可随时调整</span></div>
        <div className="divide-y divide-[#E3E9EB] rounded-xl border border-[#D7E0E4] bg-white/70 dark:divide-white/10 dark:border-white/10 dark:bg-[#202A2E]">{items.map(item => <PlanRow key={item.id} item={item} onToggle={onToggle} />)}</div>
      </div>
    </section>
  )
}

function PlanRow({ item, onToggle }: { item: HealthPlanItem; onToggle: (id: string) => void }) {
  const Icon = item.kind === "movement" ? Activity : item.kind === "sleep" ? Moon : Zap
  return (
    <div className="flex min-h-[76px] items-center gap-3 px-3.5 py-3 sm:px-4"><div className="flex w-12 shrink-0 items-center gap-1.5 text-[11px] font-semibold text-[#52616C] dark:text-[#B7C5C9]"><Clock3 className="size-3.5" aria-hidden="true" />{item.time}</div><div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#E8F4F1] text-[#0F766E] dark:bg-[#163A37] dark:text-[#8BE2D0]"><Icon className="size-4" aria-hidden="true" /></div><div className="min-w-0 flex-1"><p className={cn("text-[13px] font-semibold text-[#1B232B] dark:text-[#F3F7FA]", item.done && "line-through opacity-60")}>{item.title}</p><p className="mt-0.5 truncate text-[11px] text-[#718087] dark:text-[#AEBBC5]">{item.detail}</p></div><button type="button" onClick={() => onToggle(item.id)} aria-label={item.done ? `标记${item.title}未完成` : `完成${item.title}`} className={cn("fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-full border", item.done ? "border-[#0F766E] bg-[#0F766E] text-white" : "border-[#C8D5D8] text-[#819096] hover:border-[#0F766E] hover:text-[#0F766E] dark:border-white/20 dark:text-[#AEBBC5]")}>{item.done ? <Check className="size-4" aria-hidden="true" /> : <span className="size-2 rounded-full border border-current" />}</button></div>
  )
}

export function TrendPanel({ sleep, recovery }: { sleep: number[]; recovery: number[] }) {
  return (
    <section className="mx-auto grid max-w-[1240px] gap-4 px-4 py-5 sm:px-7 sm:py-7 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,0.8fr)]">
      <div className="rounded-xl border border-[#D7E0E4] bg-white/80 p-4 dark:border-white/10 dark:bg-[#202A2E] sm:p-5"><div className="flex items-start justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#718087] dark:text-[#AEBBC5]">过去 7 天</p><h2 className="mt-1 text-[18px] font-semibold text-[#1B232B] dark:text-[#F3F7FA]">睡眠与恢复正在同向变化</h2></div><span className="rounded-full bg-[#FFF4D9] px-2.5 py-1 text-[10px] font-semibold text-[#8A5A05] dark:bg-[#44361B] dark:text-[#F5CA77]">需要观察</span></div><div className="mt-6 grid gap-5 sm:grid-cols-2"><TrendBars label="睡眠时长" values={sleep} unit="小时" tone="teal" /><TrendBars label="恢复状态" values={recovery} unit="指数" tone="amber" /></div><p className="mt-5 border-t border-[#E3E9EB] pt-4 text-[11px] leading-5 text-[#718087] dark:border-white/10 dark:text-[#AEBBC5]">周三和周五的晚间入睡时间较晚，第二天 HRV 也随之下降。先调整睡眠窗口，再判断训练量是否需要改变。</p></div>
      <div className="rounded-xl border border-[#D7E0E4] bg-[#F3F8F7] p-4 dark:border-white/10 dark:bg-[#172A29] sm:p-5"><div className="flex items-center gap-2 text-[#0F766E] dark:text-[#8BE2D0]"><Sparkles className="size-4" aria-hidden="true" /><p className="text-[12px] font-semibold">管家的观察</p></div><p className="mt-4 text-[15px] font-semibold leading-6 text-[#173239] dark:text-[#F1FAF8]">先照顾恢复，再追求更多。</p><p className="mt-2 text-[12px] leading-5 text-[#56716C] dark:text-[#B8CDCA]">趋势里最稳定的信号不是步数，而是睡眠时间和第二天的恢复感受。你可以在今天的签到里告诉我这两者是否一致。</p><button type="button" className="fluid-press mt-5 inline-flex min-h-10 items-center gap-2 rounded-xl border border-[#B9D8D1] bg-white/70 px-3 text-[12px] font-semibold text-[#0F766E] hover:bg-white dark:border-[#39766C] dark:bg-[#1C3A37] dark:text-[#9BE4D3]">查看依据<ChevronRight className="size-3.5" aria-hidden="true" /></button></div>
    </section>
  )
}

function TrendBars({ label, values, unit, tone }: { label: string; values: number[]; unit: string; tone: "teal" | "amber" }) {
  const max = Math.max(...values)
  const barColor = tone === "teal" ? "bg-[#0F766E] dark:bg-[#79D0BE]" : "bg-[#C58A24] dark:bg-[#E9B65D]"
  return <div><div className="flex items-center justify-between text-[11px] font-semibold text-[#52616C] dark:text-[#B7C5C9]"><span>{label}</span><span className="font-normal text-[#8A989D]">{unit}</span></div><div className="mt-3 flex h-28 items-end gap-1.5" role="img" aria-label={`${label}过去七天趋势：${values.join("、")}`}><div className="flex h-full flex-1 flex-col justify-between text-[9px] text-[#9AA7AB]"><span>高</span><span>低</span></div>{values.map((value, index) => <div key={`${label}-${index}`} className="flex h-full flex-1 items-end"><div className={cn("w-full rounded-t-md transition-[height] duration-300", barColor)} style={{ height: `${Math.max(18, (value / max) * 100)}%` }} /></div>)}</div><div className="mt-2 flex pl-5 text-[9px] text-[#9AA7AB]"><span className="flex-1">一</span><span className="flex-1 text-center">三</span><span className="flex-1 text-center">五</span><span className="flex-1 text-right">日</span></div></div>
}

export function PlanPanel({ items, onToggle }: { items: HealthPlanItem[]; onToggle: (id: string) => void }) {
  return <div className="mx-auto max-w-[900px] px-4 py-5 sm:px-7 sm:py-8"><div className="mb-5 max-w-xl"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#718087] dark:text-[#AEBBC5]">个人节奏</p><h2 className="mt-1 text-[24px] font-semibold tracking-tight text-[#1B232B] dark:text-[#F3F7FA]">今天只需要完成三件事。</h2><p className="mt-2 text-[13px] leading-6 text-[#718087] dark:text-[#AEBBC5]">计划会根据你的签到和新数据调整。完成不是目的，找到适合今天的节奏才是。</p></div><TodayPlan items={items} onToggle={onToggle} /><div className="mt-4 flex items-center gap-3 rounded-xl border border-[#D7E0E4] bg-[#F8FAFA] px-4 py-4 text-[12px] text-[#52616C] dark:border-white/10 dark:bg-[#202A2E] dark:text-[#B7C5C9]"><HeartPulse className="size-4 shrink-0 text-[#0F766E] dark:text-[#8BE2D0]" aria-hidden="true" /><span>下次调整将在你完成下午签到后进行。</span></div></div>
}

export function RecordsPanel({ onConnect }: { onConnect: () => void }) {
  return <div className="mx-auto max-w-[900px] px-4 py-5 sm:px-7 sm:py-8"><div className="mb-5"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#718087] dark:text-[#AEBBC5]">数据与隐私</p><h2 className="mt-1 text-[24px] font-semibold tracking-tight text-[#1B232B] dark:text-[#F3F7FA]">你始终知道管家看到了什么。</h2><p className="mt-2 max-w-xl text-[13px] leading-6 text-[#718087] dark:text-[#AEBBC5]">当前页面使用示例数据。连接 Apple 健康后，你可以逐项管理读取权限，数据不会被用于广告或与其他产品混用。</p></div><div className="divide-y divide-[#E3E9EB] rounded-xl border border-[#D7E0E4] bg-white/75 dark:divide-white/10 dark:border-white/10 dark:bg-[#202A2E]"><RecordRow icon={<Watch className="size-4" />} title="Apple 健康" detail="尚未建立真实连接" action={<button type="button" onClick={onConnect} className="fluid-press min-h-11 rounded-lg bg-[#0F766E] px-3 text-[11px] font-semibold text-white hover:bg-[#0B625C]">连接</button>} /><RecordRow icon={<ShieldCheck className="size-4" />} title="数据权限" detail="按类别授权，随时可以撤回" action={<ChevronRight className="size-4 text-[#8A989D]" aria-hidden="true" />} /><RecordRow icon={<CircleHelp className="size-4" />} title="建议依据" detail="个人基线、趋势和你的主动反馈" action={<ChevronRight className="size-4 text-[#8A989D]" aria-hidden="true" />} /></div><div className="mt-4 flex items-start gap-3 rounded-xl border border-[#D7E0E4] bg-[#F8FAFA] px-4 py-4 text-[11px] leading-5 text-[#718087] dark:border-white/10 dark:bg-[#202A2E] dark:text-[#AEBBC5]"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#0F766E] dark:text-[#8BE2D0]" aria-hidden="true" /><span>健康建议用于日常管理，不替代医生诊断。出现紧急症状时，请联系当地急救服务。</span></div></div>
}

function RecordRow({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action: ReactNode }) {
  return <div className="flex min-h-[68px] items-center gap-3 px-4 py-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#E8F4F1] text-[#0F766E] dark:bg-[#163A37] dark:text-[#8BE2D0]">{icon}</div><div className="min-w-0 flex-1"><p className="text-[13px] font-semibold text-[#1B232B] dark:text-[#F3F7FA]">{title}</p><p className="mt-0.5 text-[11px] text-[#718087] dark:text-[#AEBBC5]">{detail}</p></div>{action}</div>
}

export function ConversationPanel({ messages, value, onChange, onSubmit }: { messages: HealthMessage[]; value: string; onChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <section aria-labelledby="health-conversation-title" className="border-b border-[#D7E0E4] px-4 py-5 dark:border-white/10 sm:px-7 sm:py-6"><div className="mx-auto max-w-[1240px]"><div className="mb-3 flex items-center gap-2"><div className="flex size-7 items-center justify-center rounded-full bg-[#0F766E] text-white"><HeartPulse className="size-3.5" aria-hidden="true" /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#718087] dark:text-[#AEBBC5]">持续对话</p><h3 id="health-conversation-title" className="text-[15px] font-semibold text-[#1B232B] dark:text-[#F3F7FA]">告诉我今天真实的感受</h3></div></div><div className="space-y-2">{messages.slice(-3).map(message => <div key={message.id} className={cn("max-w-2xl rounded-xl px-3.5 py-3 text-[12px] leading-5", message.role === "assistant" ? "bg-[#F3F8F7] text-[#45625E] dark:bg-[#172A29] dark:text-[#B8CDCA]" : "ml-auto bg-[#EAF0F8] text-[#35506C] dark:bg-[#1E3049] dark:text-[#C8DCF5]")}><span className="sr-only">{message.role === "assistant" ? "健康管家：" : "你："}</span>{message.content}</div>)}</div><form onSubmit={onSubmit} className="mt-3 flex items-center gap-2 rounded-xl border border-[#C9D7D9] bg-white px-2 py-1.5 transition-colors focus-within:border-[#0F766E] dark:border-white/15 dark:bg-[#202A2E]"><input value={value} onChange={event => onChange(event.target.value)} aria-label="询问健康管家" placeholder="比如：今天适合训练吗？" className="min-h-11 min-w-0 flex-1 bg-transparent px-2 text-[12px] text-[#1B232B] outline-none placeholder:text-[#93A0A5] dark:text-[#F3F7FA]" /><button type="submit" aria-label="发送健康问题" disabled={!value.trim()} className="fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-lg bg-[#0F766E] text-white hover:bg-[#0B625C] disabled:cursor-not-allowed disabled:opacity-40"><ArrowUpRight className="size-4" aria-hidden="true" /></button></form></div></section>
}
