"use client"

import { useState } from "react"
import { Code2, Loader2 } from "lucide-react"
import { CompanionAvatar } from "@/components/companion-avatar"

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
    <main className="flex h-dvh w-full items-center justify-center overflow-y-auto bg-background px-5 py-8 sm:px-6">
      <div className="w-full max-w-sm">
        <header className="mb-8 flex flex-col items-center text-center">
          <CompanionAvatar size={72} eager className="size-16" />
          <h1 className="mt-4 font-heading text-3xl text-foreground">MyChat</h1>
          <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold uppercase text-primary">
            <Code2 className="size-3" aria-hidden="true" />
            Build &amp; ship from your phone
          </p>
          <p className="mt-3 max-w-xs text-sm leading-6 text-muted-foreground">
            不用电脑。连接 GitHub，让 Code 在云端读仓库、改代码、跑测试并发布上线。
          </p>
          <p className="mt-2 text-sm italic text-muted-foreground">
            {mode === "signin" ? "回来了，先登录吧" : "新朋友，先注册一个"}
          </p>
        </header>

        <form
          className="space-y-4"
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
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {mode === "signin" ? "登录" : "注册"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-sm text-muted-foreground">或</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <button
          type="button"
          onClick={() => { void handleGuest() }}
          disabled={loading || guestLoading}
          aria-busy={guestLoading}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-border bg-secondary px-4 text-base font-semibold text-secondary-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-60"
        >
          {guestLoading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          以游客身份继续
        </button>

        <div className="mt-5 flex min-h-11 items-center justify-center gap-1 text-sm text-muted-foreground">
          {mode === "signin" ? "还没有账号？" : "已经有账号了？"}
          <button
            type="button"
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError("") }}
            className="min-h-11 rounded-md px-2 font-semibold text-primary underline underline-offset-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {mode === "signin" ? "去注册" : "去登录"}
          </button>
        </div>
      </div>
    </main>
  )
}
