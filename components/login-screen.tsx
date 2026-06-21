"use client"

import { useState } from "react"
import Image from "next/image"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { Loader2 } from "lucide-react"

export function LoginScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")

  const supabase = createClient()

  async function handleEmailAuth() {
    setError("")
    setMessage("")
    if (!email.trim() || !password.trim()) {
      setError("请填写邮箱和密码")
      return
    }
    if (password.length < 6) {
      setError("密码至少 6 位")
      return
    }
    setLoading(true)
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email: email.trim(), password })
        if (error) { setError(translateError(error.message)); return }
        setMessage("注册成功！如果没有自动进入，请查收邮箱确认邮件。")
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (error) { setError(translateError(error.message)); return }
        // 登录成功后页面会自动刷新进入聊天
      }
    } catch {
      setError("网络错误，请重试")
    } finally {
      setLoading(false)
    }
  }

  async function handleGoogle() {
    setError("")
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      })
      if (error) { setError(translateError(error.message)); setLoading(false) }
    } catch {
      setError("无法连接谷歌登录")
      setLoading(false)
    }
  }

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background paper-grain px-6">
      <div className="w-full max-w-sm">
        {/* 头像与标题 */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div style={{ backgroundColor: "#FCF1DE" }}>
            <Image src="/companion.png" alt="" width={72} height={72} priority className="size-16 select-none" style={{ mixBlendMode: "multiply" }} />
          </div>
          <h1 className="mt-4 font-heading text-2xl tracking-wide text-foreground">笺</h1>
          <p className="mt-1.5 text-xs italic tracking-wider text-muted-foreground">
            {mode === "signin" ? "回来了，先登录吧" : "新朋友，先注册一个"}
          </p>
        </div>

        {/* 邮箱密码 */}
        <div className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); setError("") }}
            placeholder="邮箱"
            autoComplete="email"
            className="w-full rounded-2xl border border-border/70 bg-card/80 px-4 py-3 text-sm outline-none focus:border-primary/50 placeholder:text-muted-foreground/50"
          />
          <input
            type="password"
            value={password}
            onChange={e => { setPassword(e.target.value); setError("") }}
            onKeyDown={e => { if (e.key === "Enter") handleEmailAuth() }}
            placeholder="密码（至少 6 位）"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className="w-full rounded-2xl border border-border/70 bg-card/80 px-4 py-3 text-sm outline-none focus:border-primary/50 placeholder:text-muted-foreground/50"
          />

          {error && <p className="px-1 text-xs text-destructive">{error}</p>}
          {message && <p className="px-1 text-xs text-primary">{message}</p>}

          <button
            onClick={handleEmailAuth}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading && <Loader2 className="size-4 animate-spin" />}
            {mode === "signin" ? "登录" : "注册"}
          </button>
        </div>

        {/* 分隔线 */}
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <span className="text-[11px] tracking-wider text-muted-foreground">或</span>
          <div className="h-px flex-1 bg-border/60" />
        </div>

        {/* 谷歌登录 */}
        <button
          onClick={handleGoogle}
          disabled={loading}
          className="flex w-full items-center justify-center gap-2.5 rounded-2xl border border-border/70 bg-card/80 px-4 py-3 text-sm text-foreground transition-colors hover:border-border disabled:opacity-60"
        >
          <GoogleIcon />
          用谷歌账号登录
        </button>

        {/* 切换登录/注册 */}
        <p className="mt-6 text-center text-xs text-muted-foreground">
          {mode === "signin" ? "还没有账号？" : "已经有账号了？"}
          <button
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setMessage("") }}
            className="ml-1 text-primary underline underline-offset-4 hover:opacity-80"
          >
            {mode === "signin" ? "去注册" : "去登录"}
          </button>
        </p>
      </div>
    </div>
  )
}

function translateError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes("invalid login credentials")) return "邮箱或密码不对"
  if (m.includes("user already registered")) return "这个邮箱已经注册过了，直接登录吧"
  if (m.includes("email not confirmed")) return "邮箱还没确认，请查收确认邮件"
  if (m.includes("rate limit")) return "操作太频繁，稍等一下再试"
  if (m.includes("provider is not enabled")) return "谷歌登录还没在后台开启"
  return msg
}

function GoogleIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  )
}
