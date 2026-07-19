"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"

export function LoginScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [guestLoading, setGuestLoading] = useState(false)
  const [error, setError] = useState("")

  async function handleEmailAuth() {
    setError("")
    if (!email.trim() || !password.trim()) { setError("请填写邮箱和密码"); return }
    if (password.length < 6) { setError("密码至少 6 位"); return }
    setLoading(true)
    try {
      const response = await fetch("/api/auth/email", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ mode, email: email.trim(), password }),
      })
      const payload = await response.json().catch(() => null) as {
        error?: unknown
        requiresConfirmation?: unknown
      } | null
      if (!response.ok) {
        if (response.status === 429) setError("操作太频繁，稍等一下再试")
        else if (response.status === 503) setError("登录服务暂时不可用，请稍后再试")
        else setError(typeof payload?.error === "string" ? payload.error : "登录失败，请重试")
        return
      }
      if (payload?.requiresConfirmation === true) {
        setError("请检查邮箱并完成验证后登录")
        return
      }
      window.location.reload()
    } catch {
      setError("网络错误，请重试")
    } finally {
      setLoading(false)
    }
  }

  async function handleGuest() {
    setError("")
    setGuestLoading(true)
    try {
      const response = await fetch("/api/auth/anonymous", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      })
      const payload = await response.json().catch(() => null) as { error?: unknown } | null
      if (!response.ok) {
        if (response.status === 429) setError("游客登录请求过于频繁，请稍后再试")
        else if (response.status === 503) setError("登录服务暂时不可用，请稍后再试")
        else setError(typeof payload?.error === "string" ? payload.error : "游客登录失败，请重试")
        return
      }
      window.location.reload()
    } catch {
      setError("网络错误，请重试")
    } finally {
      setGuestLoading(false)
    }
  }

  return (
    <main className="flex min-h-dvh w-full items-center justify-center overflow-y-auto bg-background px-[clamp(1rem,5vw,1.5rem)] py-[clamp(1.5rem,6vh,3.5rem)]">
      <div className="w-full max-w-[clamp(20rem,88vw,24rem)]">
        <header className="mb-[clamp(1.75rem,5vh,3rem)] text-center">
          <h1 className="font-heading text-[clamp(2.25rem,10vw,4rem)] leading-none tracking-[-0.04em] text-foreground">
            My Chat
          </h1>
        </header>

        <form
          className="space-y-[clamp(0.875rem,2.2vh,1.25rem)]"
          onSubmit={event => { event.preventDefault(); void handleEmailAuth() }}
        >
          <div className="space-y-2">
            <label htmlFor="login-email" className="block text-sm font-semibold text-foreground">
              邮箱地址
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={event => { setEmail(event.target.value); setError("") }}
              placeholder="name@example.com"
              autoComplete="email"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
              className="min-h-12 w-full rounded-lg border border-input bg-card px-4 text-base text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="login-password" className="block text-sm font-semibold text-foreground">
              密码
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={event => { setPassword(event.target.value); setError("") }}
              placeholder="至少 6 位"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "login-error" : undefined}
              className="min-h-12 w-full rounded-lg border border-input bg-card px-4 text-base text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>

          {error && (
            <p id="login-error" role="alert" aria-live="polite" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || guestLoading}
            aria-busy={loading}
            className="fluid-press flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-base font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {mode === "signin" ? "登录" : "注册"}
          </button>
        </form>

        <div className="my-[clamp(1rem,3vh,1.5rem)] flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-sm text-muted-foreground">或</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          onClick={() => { void handleGuest() }}
          disabled={loading || guestLoading}
          aria-busy={guestLoading}
          className="fluid-press flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-border bg-secondary px-4 text-base font-semibold text-secondary-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
        >
          {guestLoading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          以游客身份继续
        </button>

        <div className="mt-[clamp(1rem,3vh,1.5rem)] flex min-h-11 items-center justify-center gap-1 text-sm text-muted-foreground">
          {mode === "signin" ? "还没有账号？" : "已经有账号了？"}
          <button
            type="button"
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError("") }}
            className="fluid-press min-h-11 rounded-md px-2 font-semibold text-primary underline underline-offset-4 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {mode === "signin" ? "去注册" : "去登录"}
          </button>
        </div>
      </div>
    </main>
  )
}
