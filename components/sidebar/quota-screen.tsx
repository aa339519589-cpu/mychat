"use client"

import { useEffect, useState } from "react"
import { fetchQuota, type QuotaSnapshot } from "@/lib/data"
import { cn } from "@/lib/utils"

export function QuotaScreen() {
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [codeInput, setCodeInput] = useState('')
  const [codeLoading, setCodeLoading] = useState(false)
  const [codeMsg, setCodeMsg] = useState('')

  useEffect(() => {
    (async () => {
      const q = await fetchQuota()
      setQuota(q)
      setLoading(false)
    })()

    const timer = setInterval(async () => {
      const q = await fetchQuota()
      setQuota(q)
    }, 10_000)

    return () => { clearInterval(timer) }
  }, [])

  async function handleRedeemCode() {
    if (!codeInput.trim()) return
    setCodeLoading(true)
    setCodeMsg('')
    try {
      const res = await fetch('/api/redeem-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeInput }),
      })
      const data = await res.json()
      if (res.ok) {
        setCodeMsg(`✓ 兑换成功，获得 ${(data.tokensAdded / 1_000_000).toFixed(0)} 百万额度`)
        setCodeInput('')
        const q = await fetchQuota()
        setQuota(q)
      } else {
        setCodeMsg(data.error || '兑换失败')
      }
    } catch {
      setCodeMsg('网络错误')
    } finally {
      setCodeLoading(false)
    }
  }


  function fmtNum(n: number) { return n.toLocaleString() }
  function pct(n: number, max: number) { return Math.min(100, (n / max) * 100) }
  function fmtRemaining(windowStart: string, windowMs: number): string {
    const rem = Math.max(0, windowMs - (Date.now() - new Date(windowStart).getTime()))
    const h = Math.floor(rem / 3600000)
    const m = Math.floor((rem % 3600000) / 60000)
    if (h > 24) return `${Math.floor(h / 24)}天 ${h % 24}h 后重置`
    if (h > 0) return `${h}h ${m}m 后重置`
    return `${m}m 后重置`
  }

  if (loading) return <div className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</div>

  const t5h = (quota?.tokens5h ?? 0)
  const t7d = (quota?.tokens7d ?? 0)
  const max5h = 500_000
  const max7d = 10_000_000
  const w5h = quota?.window5hStart ?? new Date().toISOString()
  const w7d = quota?.window7dStart ?? new Date().toISOString()

  const plans = [
    { tokens: '100 万', price: 18, popular: false },
    { tokens: '300 万', price: 48, popular: true },
    { tokens: '500 万', price: 78, popular: false },
  ]

  return (
    <div className="space-y-4 px-4">

      {/* 账户余额 */}
      <div className="rounded-2xl bg-sidebar-primary/15 px-4 py-3 border border-sidebar-primary/30">
        <div className="text-[11px] text-muted-foreground">账户余额</div>
        <div className="mt-1.5 text-[21px] font-semibold text-foreground">{fmtNum(quota?.balance ?? 0)}</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">token（不受时间窗口限制）</div>
      </div>

      <div className="space-y-2.5 rounded-2xl bg-sidebar-accent/55 p-4 border border-sidebar-border">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-medium text-foreground">5 小时用量</span>
          <span className="text-[10px] text-muted-foreground">{fmtRemaining(w5h, 5 * 3600 * 1000)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent/70">
          <div className="h-full rounded-full bg-sidebar-primary transition-all" style={{ width: `${pct(t5h, max5h)}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>{fmtNum(t5h)}</span>
          <span>{fmtNum(max5h)}</span>
        </div>
      </div>

      <div className="space-y-2.5 rounded-2xl bg-sidebar-accent/55 p-4 border border-sidebar-border">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-medium text-foreground">7 天用量</span>
          <span className="text-[10px] text-muted-foreground">{fmtRemaining(w7d, 7 * 86400 * 1000)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent/70">
          <div className="h-full rounded-full bg-sidebar-primary transition-all" style={{ width: `${pct(t7d, max7d)}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>{fmtNum(t7d)}</span>
          <span>{fmtNum(max7d)}</span>
        </div>
      </div>

      {/* 计费倍率简介 */}
      <div className="rounded-2xl bg-sidebar-accent/55 px-4 py-3 border border-sidebar-border">
        <div className="text-[11px] font-medium text-foreground">按模型计费倍率</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span>快速 <span className="font-medium text-foreground">×0.8</span></span>
          <span className="text-sidebar-border">·</span>
          <span>均衡 <span className="font-medium text-foreground">×1</span></span>
          <span className="text-sidebar-border">·</span>
          <span>深度／深研 <span className="font-medium text-foreground">×3</span></span>
        </div>
      </div>

      {/* 购买额度 */}
      <div className="space-y-2.5 pt-1">
        <div className="text-[12px] font-medium text-foreground">购买额度</div>
        <div className="grid grid-cols-2 gap-2.5">
          {plans.map((p) => (
            <button
              key={p.tokens}
              type="button"
              className={`relative flex flex-col items-center gap-1 rounded-2xl px-3 py-4 border transition-transform active:scale-[0.98] ${p.popular ? 'bg-sidebar-primary/10 border-sidebar-primary/40' : 'bg-sidebar-accent/55 border-sidebar-border'}`}
            >
              {p.popular && (
                <span className="absolute -top-2 rounded-full bg-sidebar-primary px-2 py-0.5 text-[9px] font-medium text-sidebar-primary-foreground">最划算</span>
              )}
              <span className="text-[14px] font-semibold text-foreground">{p.tokens}</span>
              <span className="text-[10px] text-muted-foreground">token 额度</span>
              <span className="mt-1 text-[14px] font-semibold text-sidebar-primary">¥{p.price}</span>
            </button>
          ))}
          <button
            type="button"
            className="flex flex-col items-center justify-center gap-1 rounded-2xl px-3 py-4 border border-sidebar-border bg-sidebar-accent/55 transition-transform active:scale-[0.98]"
          >
            <span className="text-[14px] font-semibold text-foreground">自定义</span>
            <span className="text-[10px] text-muted-foreground">按需购买</span>
          </button>
        </div>
        <p className="px-1 text-[10px] text-muted-foreground">购买功能即将开放</p>
      </div>

      {/* 邀请码兑换 */}
      <div className="space-y-2">
        <div className="text-[12px] font-medium text-foreground">邀请码兑换</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={codeInput}
            onChange={e => setCodeInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRedeemCode() }}
            placeholder="输入邀请码"
            className="flex-1 rounded-xl bg-sidebar-accent/50 px-3 py-2 text-sm outline-none focus:bg-sidebar-accent/75 placeholder:text-muted-foreground/50"
            disabled={codeLoading}
          />
          <button
            onClick={handleRedeemCode}
            disabled={codeLoading || !codeInput.trim()}
            className="rounded-xl bg-sidebar-primary px-4 py-2 text-sm text-sidebar-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {codeLoading ? '兑换中…' : '兑换'}
          </button>
        </div>
        {codeMsg && (
          <p className={cn('text-[11px]', codeMsg.startsWith('✓') ? 'text-green-600' : 'text-destructive')}>
            {codeMsg}
          </p>
        )}
      </div>

    </div>
  )
}

// ── 设置（二级全屏页内容）：两个板块 —— 「基础与记忆」｜「使用额度」──
// 装在 ScreenPanel 里（顶部统一返回头由外壳提供），标签切换两块内容，不再逐层滑入碎片子页。

