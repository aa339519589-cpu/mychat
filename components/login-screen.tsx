"use client"

import { useState } from "react"
import Image from "next/image"
import { createClient } from "@/lib/supabase/client"
import { Loader2 } from "lucide-react"

export function LoginScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [guestLoading, setGuestLoading] = useState(false)
  const [error, setError] = useState("")

  const supabase = createClient()

  async function handleEmailAuth() {
    setError("")
    if (!email.trim() || !password.trim()) { setError("请填写邮箱和密码"); return }
    if (password.length < 6) { setError("密码至少 6 位"); return }
    setLoading(true)
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email: email.trim(), password })
        if (error) { setError(translateError(error.message)); return }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
        if (error) { setError(translateError(error.message)); return }
      }
    } catch {
      setError("网络错误，请重试")
    } finally {
      setLoading(false)
    }
  }

  async function handleGuest() {
    setGuestLoading(true)
    try {
      const { error } = await supabase.auth.signInAnonymously()
      if (error) setError("游客登录失败，请重试")
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
          <div className="avatar-box">
            <Image src="/companion.png" alt="" width={72} height={72} priority className="avatar-light size-16 select-none" style={{ mixBlendMode: "multiply" }} />
            <Image src="/companion-dark.png" alt="" width={72} height={72} priority className="avatar-dark size-16 select-none" />
          </div>
          <h1 className="mt-4 font-heading text-2xl tracking-wide text-foreground">简</h1>
          <p className="mt-1.5 text-xs italic tracking-wider text-muted-foreground">
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
          <span className="text-[11px] tracking-wider text-muted-foreground">或</span>
          <div className="h-px flex-1 bg-border/60" />
        </div>

        <button
          onClick={handleGuest}
          disabled={loading || guestLoading}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border/70 bg-card/50 px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-60"
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

function translateError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes("invalid login credentials")) return "邮箱或密码不对"
  if (m.includes("user already registered")) return "这个邮箱已经注册过了，直接登录吧"
  if (m.includes("rate limit")) return "操作太频繁，稍等一下再试"
  return msg
}
