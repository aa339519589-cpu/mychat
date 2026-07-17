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
    <div className="flex h-dvh w-full items-center justify-center bg-background paper-grain px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <CompanionAvatar size={72} eager className="size-16" />
          <h1 className="mt-4 font-heading text-2xl tracking-wide text-foreground">MyChat</h1>
          <p className="mt-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-primary">
            <Code2 className="size-3" aria-hidden="true" />
            Build &amp; ship from your phone
          </p>
          <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">
            不用电脑。连接 GitHub，让 Code 在云端读仓库、改代码、跑测试并发布上线。
          </p>
          <p className="mt-2 text-xs italic tracking-wider text-muted-foreground">
            {mode === "signin" ? "回来了，先登录吧" : "新朋友，先注册一个"}
          </p>
        </div>

        <div className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); setError("") }}
            placeholder="邮箱"
            autoComplete="email"
            className="w-full rounded-2xl bg-secondary/50 px-4 py-3.5 text-sm outline-none transition-colors focus:bg-secondary/75 placeholder:text-muted-foreground/50"
          />
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError("") }}
            onKeyDown={e => { if (e.key === "Enter") handleEmailAuth() }}
            placeholder="密码（至少 6 位）"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className="w-full rounded-2xl bg-secondary/50 px-4 py-3.5 text-sm outline-none transition-colors focus:bg-secondary/75 placeholder:text-muted-foreground/50"
          />

          {error && <p className="px-1 text-xs text-destructive">{error}</p>}

          <button
            onClick={handleEmailAuth}
            disabled={loading || guestLoading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {mode === "signin" ? "登录" : "注册"}
          </button>
        </div>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <span className="text-[10px] tracking-wider text-muted-foreground">或</span>
          <div className="h-px flex-1 bg-border/60" />
        </div>

        <button
          onClick={handleGuest}
          disabled={loading || guestLoading}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-secondary/40 px-4 py-3.5 text-sm text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground disabled:opacity-60"
        >
          {guestLoading && <Loader2 className="size-4 animate-spin" />}
          以游客身份继续
        </button>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {mode === "signin" ? "还没有账号？" : "已经有账号了？"}
          <button
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError("") }}
            className="ml-1 text-primary underline underline-offset-4 hover:opacity-80"
          >
            {mode === "signin" ? "去注册" : "去登录"}
          </button>
        </p>
      </div>
    </div>
  )
}
