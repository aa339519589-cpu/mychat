"use client"

import { Check, HeartPulse, ShieldCheck, Smartphone, Watch, X } from "lucide-react"
import type { ReactNode } from "react"

export function HealthConnectionDialog({ open, onClose, onAcknowledge }: { open: boolean; onClose: () => void; onAcknowledge: () => void }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-[#071923]/45 p-0 backdrop-blur-sm sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="health-connect-title">
      <div className="w-full max-w-lg overflow-hidden rounded-t-3xl border border-[#D7E0E4] bg-[#FCFDFD] shadow-[0_24px_80px_rgb(7_25_35/24%)] dark:border-white/10 dark:bg-[#202A2E] sm:rounded-2xl">
        <div className="flex items-center gap-3 border-b border-[#E3E9EB] px-5 py-4 dark:border-white/10"><div className="flex size-9 items-center justify-center rounded-xl bg-[#E8F4F1] text-[#0F766E] dark:bg-[#163A37] dark:text-[#8BE2D0]"><HeartPulse className="size-5" aria-hidden="true" /></div><div className="min-w-0 flex-1"><h2 id="health-connect-title" className="text-[16px] font-semibold text-[#1B232B] dark:text-[#F3F7FA]">连接 Apple 健康</h2><p className="text-[11px] text-[#718087] dark:text-[#AEBBC5]">让管家从你的真实节奏开始工作</p></div><button type="button" onClick={onClose} aria-label="关闭连接说明" className="fluid-press fluid-icon-press flex size-10 items-center justify-center rounded-full text-[#718087] hover:bg-[#E7EFF1] dark:hover:bg-white/10"><X className="size-4" aria-hidden="true" /></button></div>
        <div className="space-y-4 px-5 py-5"><p className="text-[13px] leading-6 text-[#52616C] dark:text-[#B7C5C9]">当前 MyChat 网页不能直接读取 HealthKit。需要在 iPhone 上用 MyChat 的同步端完成授权，网页会继续展示你的简报、趋势和计划。</p><div className="space-y-2"><ConnectionStep icon={<Smartphone className="size-4" />} title="在 iPhone 上打开同步端" detail="通过 MyChat App 或配套同步端进入连接流程。" /><ConnectionStep icon={<Watch className="size-4" />} title="逐项授权健康数据" detail="睡眠、活动、训练和心率可以分开管理。" /><ConnectionStep icon={<ShieldCheck className="size-4" />} title="回到这里查看分析" detail="同步完成后，个人基线会逐步替换示例数据。" /></div><div className="rounded-xl border border-[#CFE3DE] bg-[#F3F8F7] px-3.5 py-3 text-[11px] leading-5 text-[#4E6B65] dark:border-[#39766C] dark:bg-[#172A29] dark:text-[#B8CDCA]"><ShieldCheck className="mr-1 inline size-3.5 align-[-2px] text-[#0F766E] dark:text-[#8BE2D0]" aria-hidden="true" />你可以随时撤回权限。我们不会把健康数据用于广告。</div></div>
        <div className="flex flex-col-reverse gap-2 border-t border-[#E3E9EB] px-5 py-4 sm:flex-row sm:justify-end dark:border-white/10"><button type="button" onClick={onClose} className="fluid-press min-h-11 rounded-xl px-4 text-[12px] font-semibold text-[#52616C] hover:bg-[#EEF3F4] dark:text-[#B7C5C9] dark:hover:bg-white/10">稍后连接</button><button type="button" onClick={onAcknowledge} className="fluid-press inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[#0F766E] px-4 text-[12px] font-semibold text-white hover:bg-[#0B625C]">我已在 iPhone 上授权<Check className="size-3.5" aria-hidden="true" /></button></div>
      </div>
    </div>
  )
}

function ConnectionStep({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="flex items-start gap-3 rounded-xl border border-[#E3E9EB] bg-white px-3.5 py-3 dark:border-white/10 dark:bg-[#252F33]"><div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#EAF0F8] text-[#3564A8] dark:bg-[#1E3049] dark:text-[#8DB6F1]">{icon}</div><div><p className="text-[12px] font-semibold text-[#1B232B] dark:text-[#F3F7FA]">{title}</p><p className="mt-0.5 text-[11px] leading-5 text-[#718087] dark:text-[#AEBBC5]">{detail}</p></div></div>
}
