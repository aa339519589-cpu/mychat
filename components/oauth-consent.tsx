"use client"

import { useEffect, useMemo, useState } from "react"
import { LoginScreen } from "@/components/login-screen"
import { createClient } from "@/lib/supabase/client"

type ConsentState = "loading" | "login" | "ready"

export function OAuthConsent({ params, clientName }: { params: Record<string, string>; clientName: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [state, setState] = useState<ConsentState>("loading")

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase.auth.getUser()
      if (cancelled) return
      setState(!error && data.user ? "ready" : "login")
    })()
    return () => { cancelled = true }
  }, [supabase])

  if (state === "login") return <LoginScreen />
  if (state === "loading") {
    return <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground"><p className="text-sm text-muted-foreground">正在读取授权请求…</p></main>
  }

  const scopes = (params.scope || "maestro").split(/\s+/).filter(Boolean)

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-10 text-foreground">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">My Chat</p>
        <h1 className="mt-2 text-2xl font-semibold">授权 {clientName}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">允许该应用以你当前登录的 My Chat 身份访问 Maestro Runner。任务只绑定当前用户。</p>

        <div className="mt-5 rounded-xl border border-border p-4">
          <div className="text-xs font-medium text-muted-foreground">请求范围</div>
          <ul className="mt-2 space-y-1 text-sm">
            {scopes.map(scope => <li key={scope}>· {scope}</li>)}
          </ul>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3">
          <form action="/oauth/authorize" method="post">
            {Object.entries(params).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
            <input type="hidden" name="decision" value="deny" />
            <button type="submit" className="min-h-11 w-full rounded-xl border border-border px-4 text-sm font-medium">拒绝</button>
          </form>
          <form action="/oauth/authorize" method="post">
            {Object.entries(params).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
            <input type="hidden" name="decision" value="approve" />
            <button type="submit" className="min-h-11 w-full rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">允许</button>
          </form>
        </div>
      </div>
    </main>
  )
}
