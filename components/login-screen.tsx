"use client"

import { useState } from "react"
import Image from "next/image"
import { createClient } from "@/lib/supabase/client"
import { Loader2 } from "lucide-react"

type Step = "auth" | "verify"

export function LoginScreen() {
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [step, setStep] = useState<Step>("auth")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [otp, setOtp] = useState("")
  const [loading, setLoading] = useState(false)
  const [guestLoading, setGuestLoading] = useState(false)
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
        setStep("verify")
        setMessage("验证码已发送到您的邮箱，请填写 6 位验证码。")
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

  async function handleVerify() {
    setError("")
    if (otp.length !== 6) {
      setError("请填写 6 位验证码")
      return
    }
    setLoading(true)
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: otp.trim(),
        type: "signup",
      })
      if (error) { setError("验证码不对或已过期，请重试"); return }
      // 验证成功，页面自动刷新进入聊天
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
        {/* 头像与标题 */}
        <div className="mb-8 flex flex-col items-center text-center">
          <div style={{ backgroundColor: "#FCF1DE" }}>
            <Image src="/companion.png" alt="" width={72} height={72} priority className="size-16 select-none" style={{ mixBlendMode: "multiply" }} />
          </div>
          <h1 className="mt-4 font-heading text-2xl tracking-wide text-foreground">笺</h1>
          <p className="mt-1.5 text-xs italic tracking-wider text-muted-foreground">
            {step === "verify"
              ? "填入邮箱里的验证码"
              : mode === "signin" ? "回来了，先登录吧" : "新朋友，先注册一个"}
          </p>
        </div>

        {step === "verify" ? (
          /* 验证码输入 */
          <div className="space-y-3">
            {message && <p className="px-1 text-xs text-muted-foreground">{message}</p>}
            <input
              type="text"
              value={otp}
              onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 6)); setError("") }}
              onKeyDown={e => { if (e.key === "Enter") handleVerify() }}
              placeholder="六位验证码"
              maxLength={6}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="w-full rounded-2xl border border-border/70 bg-card/80 px-4 py-3 text-center text-lg tracking-[0.4em] outline-none focus:border-primary/50 placeholder:text-muted-foreground/50 placeholder:tracking-normal placeholder:text-sm"
            />
            {error && <p className="px-1 text-xs text-destructive">{error}</p>}
            <button
              onClick={handleVerify}
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 py-3 text-sm text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {loading && <Loader2 className="size-4 animate-spin" />}
              确认
            </button>
            <button
              onClick={() => { setStep("auth"); setOtp(""); setError(""); setMessage("") }}
              className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
            >
              重新填写邮箱
            </button>
          </div>
        ) : (
          /* 邮箱密码 */
          <>
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

            {/* 分隔线 */}
            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-border/60" />
              <span className="text-[11px] tracking-wider text-muted-foreground">或</span>
              <div className="h-px flex-1 bg-border/60" />
            </div>

            {/* 游客登录 */}
            <button
              onClick={handleGuest}
              disabled={loading || guestLoading}
              className="flex w-full items-center justify-center gap-2 rounded-2xl border border-border/70 bg-card/50 px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground disabled:opacity-60"
            >
              {guestLoading && <Loader2 className="size-4 animate-spin" />}
              以游客身份继续
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
          </>
        )}
      </div>
    </div>
  )
}

function translateError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes("invalid login credentials")) return "邮箱或密码不对"
  if (m.includes("user already registered")) return "这个邮箱已经注册过了，直接登录吧"
  if (m.includes("email not confirmed")) return "邮箱还没确认，请先验证"
  if (m.includes("rate limit")) return "操作太频繁，稍等一下再试"
  return msg
}
