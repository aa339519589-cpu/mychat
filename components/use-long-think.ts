"use client"

import { useCallback, useEffect, useState } from "react"
import { LONG_THINK_ACTIVE as ACTIVE, LONG_THINK_STORAGE_KEY as STORAGE_KEY, longThinkJsonRequest as jsonRequest, type Endpoint, type JobSnapshot } from "@/components/long-think-support"

export type LongThinkStartInput = {
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
    body: JSON.stringify({
      baseUrl: input.baseUrl.trim(),
      apiKey: input.apiKey.trim(),
      model: input.model.trim(),
      displayName: input.model.trim(),
      outputKind: "chat",
      authType: "auto",
    }),
  }) as { endpoint?: Endpoint }
  if (!body.endpoint?.id) throw new Error("模型端点保存失败")
  return body.endpoint
}

async function createJob(endpointId: string, input: LongThinkStartInput): Promise<string> {
  const body = await jsonRequest("/api/long-think/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpointId,
      problem: input.problem.trim(),
      maxTokens: input.maxTokens,
      minRounds: input.minRounds,
      verifyEvery: input.verifyEvery,
    }),
  }) as { jobId?: string }
  if (!body.jobId) throw new Error("任务创建失败")
  return body.jobId
}

async function readJob(id: string): Promise<JobSnapshot> {
  const body = await jsonRequest(`/api/v1/jobs/${encodeURIComponent(id)}`) as { job?: JobSnapshot }
  if (!body.job) throw new Error("任务状态为空")
  return body.job
}

export async function startLongThinkTask(input: LongThinkStartInput): Promise<string> {
  if (!input.baseUrl.trim() || !input.model.trim() || !input.problem.trim()) throw new Error("API URL、模型和问题必须填写")
  const endpoint = await createEndpoint(input)
  return createJob(endpoint.id, input)
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

  const selectJob = useCallback((id: string) => {
    setActiveJobId(id)
    setJob(null)
    if (id) window.localStorage.setItem(STORAGE_KEY, id)
    else window.localStorage.removeItem(STORAGE_KEY)
  }, [])

  useEffect(() => {
    const remembered = window.localStorage.getItem(STORAGE_KEY) ?? ""
    if (remembered) setActiveJobId(remembered)
  }, [])

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
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 3000)
      }
    }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeJobId])

  return { activeJobId, job, selectJob }
}
