"use client"

import { ArrowRight, HeartPulse, Settings2 } from "lucide-react"

export function LocalConfigurationScreen({ message }: { message: string }) {
  return (
    <main className="flex h-dvh w-full items-center justify-center overflow-y-auto bg-background px-5 py-8 sm:px-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-[0_18px_50px_rgb(1_26_56/10%)] sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-foreground"><Settings2 className="size-5" aria-hidden="true" /></div>
        <h1 className="mt-5 text-2xl font-semibold text-foreground">本地服务需要配置</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{message}</p>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">在 <code className="rounded bg-muted px-1.5 py-0.5 text-[12px] text-foreground">.env.local</code> 填入 <code className="rounded bg-muted px-1.5 py-0.5 text-[12px] text-foreground">NEXT_PUBLIC_SUPABASE_URL</code> 和 <code className="rounded bg-muted px-1.5 py-0.5 text-[12px] text-foreground">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> 后重启开发服务。</p>
        <a href="/health-preview" className="fluid-press mt-6 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"><HeartPulse className="size-4" aria-hidden="true" />查看 Health 预览<ArrowRight className="size-4" aria-hidden="true" /></a>
      </div>
    </main>
  )
}
