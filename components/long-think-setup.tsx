"use client"

import { useEffect, useState } from "react"
import { BrainCircuit, LoaderCircle } from "lucide-react"
import type { Endpoint } from "@/components/long-think-support"
import { startLongThinkTask } from "@/components/use-long-think"

function integer(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 之间的整数`)
  return parsed
}

export function LongThinkSetup({ endpoints, onStarted, onEndpointCreated }: {
  endpoints: Endpoint[]
  onStarted: (jobId: string) => void
  onEndpointCreated: () => void
}) {
  const [endpointId, setEndpointId] = useState("")
  const [baseUrl, setBaseUrl] = useState("https://api.b.ai/v1")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("deepseek-v4-flash")
  const [problem, setProblem] = useState("")
  const [maxTokens, setMaxTokens] = useState("32768")
  const [minRounds, setMinRounds] = useState("4")
  const [verifyEvery, setVerifyEvery] = useState("6")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => { if (!endpointId && endpoints[0]) setEndpointId(endpoints[0].id) }, [endpointId, endpoints])
  const usingSaved = Boolean(endpointId)

  const start = async () => {
    setBusy(true); setError("")
    try {
      const jobId = await startLongThinkTask({
        endpointId,
        baseUrl,
        apiKey,
        model,
        problem,
        maxTokens: integer(maxTokens, "单轮最大输出 Token", 512, 262144),
        minRounds: integer(minRounds, "最少处理轮数", 1, 100000),
        verifyEvery: integer(verifyEvery, "闭环审查间隔", 1, 10000),
      })
      if (!usingSaved) onEndpointCreated()
      setApiKey("")
      onStarted(jobId)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "任务创建失败") }
    finally { setBusy(false) }
  }

  return <section className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
    <div className="rounded-[28px] border border-border/70 bg-card/55 p-4 sm:p-6">
      <label className="mb-2 block text-xs text-muted-foreground">模型连接</label>
      <select value={endpointId} onChange={event => setEndpointId(event.target.value)} className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none">
        {endpoints.map(endpoint => <option key={endpoint.id} value={endpoint.id}>{endpoint.name} · {endpoint.model}</option>)}
        <option value="">+ 添加新的 API 连接</option>
      </select>
      {!usingSaved && <div className="mt-3 grid gap-3"><input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="API URL" className="h-11 rounded-xl border border-border bg-background px-3 text-sm outline-none" /><input value={apiKey} onChange={event => setApiKey(event.target.value)} type="password" autoComplete="off" placeholder="API Key（只需配置一次）" className="h-11 rounded-xl border border-border bg-background px-3 text-sm outline-none" /><input value={model} onChange={event => setModel(event.target.value)} placeholder="模型 ID" className="h-11 rounded-xl border border-border bg-background px-3 text-sm outline-none" /></div>}
      {usingSaved && <p className="mt-2 text-xs text-muted-foreground">使用已保存的加密连接，不需要再次输入 API Key。</p>}
      <label className="mb-2 mt-5 block text-xs text-muted-foreground">问题</label><textarea value={problem} onChange={event => setProblem(event.target.value)} rows={12} placeholder="把需要真正闭环的问题完整写在这里" className="w-full resize-y rounded-2xl border border-border bg-background p-4 text-[15px] leading-6 outline-none" />
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <button disabled={busy} onClick={() => void start()} className="fluid-press mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-foreground px-5 text-sm font-medium text-background disabled:opacity-50">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <BrainCircuit className="size-4" />}开始连续处理</button>
    </div>
    <aside className="rounded-[28px] border border-border/70 bg-card/40 p-4 sm:p-5"><div className="text-xs font-medium text-muted-foreground">参数</div><label className="mt-4 block text-xs text-muted-foreground">单轮最大输出 Token</label><input type="number" inputMode="numeric" value={maxTokens} onChange={event => setMaxTokens(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /><label className="mt-4 block text-xs text-muted-foreground">最少处理轮数</label><input type="number" inputMode="numeric" value={minRounds} onChange={event => setMinRounds(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /><label className="mt-4 block text-xs text-muted-foreground">闭环审查间隔</label><input type="number" inputMode="numeric" value={verifyEvery} onChange={event => setVerifyEvery(event.target.value)} className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm" /><p className="mt-5 text-xs leading-5 text-muted-foreground">任务彼此独立。离开页面不会停止后台执行。</p></aside>
  </section>
}
