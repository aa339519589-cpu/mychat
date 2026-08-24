"use client"

import { useEffect, useMemo, useState } from "react"
import { LoginScreen } from "@/components/login-screen"
import { createClient } from "@/lib/supabase/client"

type AuthorizationDetails = {
  authorization_id: string
  client?: { id?: string; name?: string; uri?: string }
  scope?: string
}

type ConsentState =
  | { kind: "loading" }
  | { kind: "login" }
  | { kind: "error"; message: string }
  | { kind: "consent"; details: AuthorizationDetails }

export function OAuthConsent({ authorizationId }: { authorizationId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [state, setState] = useState<ConsentState>({ kind: "loading" })
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!authorizationId) {
        if (!cancelled) setState({ kind: "error", message: "缺少 authorization_id" })
        return
      }

      const { data: userData, error: userError } = await supabase.auth.getUser()
      if (cancelled) return
      if (userError || !userData.user) {
        setState({ kind: "login" })
        return
      }

      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
      if (cancelled) return
      if (error || !data) {
        setState({ kind: "error", message: error?.message || "授权请求无效或已过期" })
        return
      }
      if (!("authorization_id" in data)) {
        window.location.assign(data.redirect_url)
        return
      }
      setState({ kind: "consent", details: data as AuthorizationDetails })
    })()
    return () => { cancelled = true }
  }, [authorizationId, supabase])

  async function decide(decision: "approve" | "deny") {
    if (state.kind !== "consent" || busy) return
    setBusy(decision)
    try {
      const result = decision === "approve"
        ? await supabase.auth.oauth.approveAuthorization(state.details.authorization_id)
        : await supabase.auth.oauth.denyAuthorization(state.details.authorization_id)
      if (result.error || !result.data?.redirect_url) {
        setState({ kind: "error", message: result.error?.message || "授权处理失败" })
        return
      }
      window.location.assign(result.data.redirect_url)
    } finally {
      setBusy(null)
    }
  }

  if (state.kind === "login") return <LoginScreen />

  if (state.kind === "loading") {
    return <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground"><p className="text-sm text-muted-foreground">正在读取授权请求…</p></main>
  }

  if (state.kind === "error") {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">授权失败</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">{state.message}</p>
        </div>
      </main>
    )
  }

  const scopes = (state.details.scope || "").split(/\s+/).filter(Boolean)
  const clientName = state.details.client?.name || "ChatGPT"

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-10 text-foreground">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-sm">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">My Chat</p>
        <h1 className="mt-2 text-2xl font-semibold">授权 {clientName}</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">允许该应用以你当前登录的 My Chat 身份访问 Maestro Runner。任务只会绑定到这个用户，不使用全局 owner，也不会猜测其他用户。</p>

        <div className="mt-5 rounded-xl border border-border p-4">
          <div className="text-xs font-medium text-muted-foreground">请求范围</div>
          <ul className="mt-2 space-y-1 text-sm">
            {scopes.length ? scopes.map(scope => <li key={scope}>· {scope}</li>) : <li>· 基本身份</li>}
          </ul>
        </div>

        <div className="mt-6 flex gap-3">
          <button type="button" disabled={busy !== null} onClick={() => void decide("deny")} className="min-h-11 flex-1 rounded-xl border border-border px-4 text-sm font-medium disabled:opacity-50">拒绝</button>
          <button type="button" disabled={busy !== null} onClick={() => void decide("approve")} className="min-h-11 flex-1 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy === "approve" ? "授权中…" : "允许"}</button>
        </div>
      </div>
    </main>
  )
}
