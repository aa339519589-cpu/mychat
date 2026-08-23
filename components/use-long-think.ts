"use client"

import { useCallback, useEffect, useState } from "react"
import { LONG_THINK_ACTIVE as ACTIVE, LONG_THINK_STORAGE_KEY as STORAGE_KEY, longThinkJsonRequest as jsonRequest, type Endpoint, type JobSnapshot, type ListedJob } from "@/components/long-think-support"

export type LongThinkStartInput = {
  endpointId?: string
  baseUrl: string
  apiKey: string
  model: string
  problem: string
  maxTokens: number
  minRounds: number
  verifyEvery: number
}

async function createEndpoint(input: LongThinkStartInput): Promise<Endpoint> {
  const body = await jsonRequest("/api/endpoints", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: input.baseUrl.trim(), apiKey: input.apiKey.trim(), model: input.model.trim(), displayName: input.model.trim(), outputKind: "chat", authType: "auto" }),
  }) as { endpoint?: Endpoint }
  if (!body.endpoint?.id) throw new Error("模型端点保存失败")
  return body.endpoint
}

async function createJob(endpointId: string, input: LongThinkStartInput): Promise<string> {
  const body = await jsonRequest("/api/long-think/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpointId, problem: input.problem.trim(), maxTokens: input.maxTokens, minRounds: input.minRounds, verifyEvery: input.verifyEvery }),
  }) as { jobId?: string }
  if (!body.jobId) throw new Error("任务创建失败")
  return body.jobId
}

async function readJob(id: string): Promise<JobSnapshot> {
  const body = await jsonRequest(`/api/v1/jobs/${encodeURIComponent(id)}`) as { job?: JobSnapshot }
  if (!body.job) throw new Error("任务状态为空")
  return body.job
}

export async function loadLongThinkEndpoints(): Promise<Endpoint[]> {
  const body = await jsonRequest("/api/endpoints") as { endpoints?: Endpoint[] }
  return (body.endpoints ?? []).filter(endpoint => endpoint.outputKind === "chat" && !endpoint.needsReconnect)
}

export async function loadLongThinkJobs(): Promise<ListedJob[]> {
  const body = await jsonRequest("/api/long-think/jobs") as { jobs?: ListedJob[] }
  return body.jobs ?? []
}

export async function startLongThinkTask(input: LongThinkStartInput): Promise<string> {
  if (!input.problem.trim()) throw new Error("问题必须填写")
  let endpointId = input.endpointId?.trim() ?? ""
  if (!endpointId) {
    if (!input.baseUrl.trim() || !input.model.trim()) throw new Error("API URL 和模型必须填写")
    endpointId = (await createEndpoint(input)).id
  }
  return createJob(endpointId, input)
}

export async function stopLongThinkTask(jobId: string): Promise<void> {
  await jsonRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "user stopped long-think task" }),
  })
}

export function useLongThinkJob() {
  const [activeJobId, setActiveJobId] = useState("")
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [jobs, setJobs] = useState<ListedJob[]>([])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])

  const refreshJobs = useCallback(async () => { setJobs(await loadLongThinkJobs()) }, [])
  const refreshEndpoints = useCallback(async () => { setEndpoints(await loadLongThinkEndpoints()) }, [])
  const selectJob = useCallback((id: string) => {
    setActiveJobId(id); setJob(null)
    if (id) window.localStorage.setItem(STORAGE_KEY, id)
    else window.localStorage.removeItem(STORAGE_KEY)
  }, [])

  useEffect(() => {
    const remembered = window.localStorage.getItem(STORAGE_KEY) ?? ""
    if (remembered) setActiveJobId(remembered)
    void refreshJobs().catch(() => undefined)
    void refreshEndpoints().catch(() => undefined)
  }, [refreshEndpoints, refreshJobs])

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshJobs().catch(() => undefined) }, 3000)
    return () => window.clearInterval(timer)
  }, [refreshJobs])

  useEffect(() => {
    if (!activeJobId) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const snapshot = await readJob(activeJobId)
        if (cancelled) return
        setJob(snapshot)
        if (ACTIVE.has(snapshot.status)) timer = window.setTimeout(poll, 1500)
        else void refreshJobs().catch(() => undefined)
      } catch { if (!cancelled) timer = window.setTimeout(poll, 3000) }
    }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeJobId, refreshJobs])

  return { activeJobId, job, jobs, endpoints, selectJob, refreshJobs, refreshEndpoints }
}
