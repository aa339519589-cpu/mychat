"use client"

import { useCallback, useEffect, useState } from "react"
import { LONG_THINK_ACTIVE as ACTIVE, LONG_THINK_STORAGE_KEY as STORAGE_KEY, longThinkJsonRequest as jsonRequest, type Endpoint, type JobSnapshot, type ListedJob } from "@/components/long-think-support"

const SNAPSHOT_STORAGE_KEY = "mychat.longThink.snapshots.v1"
const DELETED_STORAGE_KEY = "mychat.longThink.deleted.v1"
const MAX_CACHED_SNAPSHOTS = 100

export type LongThinkStartInput = {
  endpointId?: string
  baseUrl: string
  apiKey: string
  model: string
  problem: string
  maxTokens: number
  minRounds: number
  verifyEvery: number
  seedCheckpoint?: Record<string, unknown>
  continuedFrom?: string
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage
}

function readRecord(key: string): Record<string, unknown> {
  const target = storage()
  if (!target) return {}
  try {
    const value = JSON.parse(target.getItem(key) ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

function listedToSnapshot(item: ListedJob): JobSnapshot {
  return {
    id: item.id,
    status: item.status,
    progress: item.progress ?? {},
    result: item.result,
    errorClass: null,
    errorCode: item.error_code,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    startedAt: item.started_at,
    terminalAt: item.terminal_at,
  }
}

function isSnapshot(value: unknown): value is JobSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.id === "string" && typeof row.status === "string"
    && typeof row.createdAt === "string" && typeof row.updatedAt === "string"
    && row.progress !== null && typeof row.progress === "object" && !Array.isArray(row.progress)
}

function cachedSnapshot(id: string): JobSnapshot | null {
  const value = readRecord(SNAPSHOT_STORAGE_KEY)[id]
  return isSnapshot(value) ? value : null
}

function writeSnapshot(snapshot: JobSnapshot): void {
  const target = storage()
  if (!target) return
  const record = readRecord(SNAPSHOT_STORAGE_KEY)
  record[snapshot.id] = snapshot
  const entries = Object.entries(record)
    .filter((entry): entry is [string, JobSnapshot] => isSnapshot(entry[1]))
    .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt))
    .slice(0, MAX_CACHED_SNAPSHOTS)
  try { target.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries))) } catch { /* storage full */ }
}

function writeListedSnapshots(items: ListedJob[]): void {
  const target = storage()
  if (!target) return
  const record = readRecord(SNAPSHOT_STORAGE_KEY)
  for (const item of items) record[item.id] = listedToSnapshot(item)
  const entries = Object.entries(record)
    .filter((entry): entry is [string, JobSnapshot] => isSnapshot(entry[1]))
    .sort((a, b) => Date.parse(b[1].updatedAt) - Date.parse(a[1].updatedAt))
    .slice(0, MAX_CACHED_SNAPSHOTS)
  try { target.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries))) } catch { /* storage full */ }
}

function removeCachedSnapshot(id: string): void {
  const target = storage()
  if (!target) return
  const record = readRecord(SNAPSHOT_STORAGE_KEY)
  delete record[id]
  try { target.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(record)) } catch { /* ignore */ }
}

function deletedIds(): Set<string> {
  const target = storage()
  if (!target) return new Set()
  try {
    const value = JSON.parse(target.getItem(DELETED_STORAGE_KEY) ?? "[]")
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [])
  } catch { return new Set() }
}

function markDeleted(id: string): void {
  const target = storage()
  if (!target) return
  const ids = deletedIds()
  ids.add(id)
  try { target.setItem(DELETED_STORAGE_KEY, JSON.stringify([...ids].slice(-500))) } catch { /* ignore */ }
  removeCachedSnapshot(id)
  if (target.getItem(STORAGE_KEY) === id) target.removeItem(STORAGE_KEY)
}

function newerSnapshot(current: JobSnapshot | null, incoming: JobSnapshot): JobSnapshot {
  if (!current || current.id !== incoming.id) return incoming
  const currentTime = Date.parse(current.updatedAt)
  const incomingTime = Date.parse(incoming.updatedAt)
  return Number.isFinite(currentTime) && Number.isFinite(incomingTime) && currentTime > incomingTime
    ? current : incoming
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
    body: JSON.stringify({
      endpointId,
      problem: input.problem.trim(),
      maxTokens: input.maxTokens,
      minRounds: input.minRounds,
      verifyEvery: input.verifyEvery,
      ...(input.seedCheckpoint ? { seedCheckpoint: input.seedCheckpoint } : {}),
      ...(input.continuedFrom ? { continuedFrom: input.continuedFrom } : {}),
    }),
  }) as { jobId?: string }
  if (!body.jobId) throw new Error("任务创建失败")
  return body.jobId
}

async function readJob(id: string): Promise<JobSnapshot> {
  const body = await jsonRequest(`/api/v1/jobs/${encodeURIComponent(id)}`) as { job?: JobSnapshot }
  if (!body.job) throw new Error("任务状态为空")
  writeSnapshot(body.job)
  return body.job
}

export async function loadLongThinkEndpoints(): Promise<Endpoint[]> {
  const body = await jsonRequest("/api/endpoints") as { endpoints?: Endpoint[] }
  return (body.endpoints ?? []).filter(endpoint => endpoint.outputKind === "chat" && !endpoint.needsReconnect)
}

export async function loadLongThinkJobs(): Promise<ListedJob[]> {
  const body = await jsonRequest("/api/long-think/jobs") as { jobs?: ListedJob[] }
  const hidden = deletedIds()
  const jobs = (body.jobs ?? []).filter(item => !hidden.has(item.id))
  writeListedSnapshots(jobs)
  return jobs
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

export async function continueLongThinkTask(jobId: string, instruction: string): Promise<string> {
  const followUp = instruction.trim()
  if (!followUp) throw new Error("请输入继续要求")
  const body = await jsonRequest(`/api/long-think/jobs/${encodeURIComponent(jobId)}/continue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction: followUp }),
  }) as { jobId?: string }
  if (!body.jobId) throw new Error("继续任务失败")
  return body.jobId
}

export async function stopLongThinkTask(jobId: string): Promise<void> {
  await jsonRequest(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "user stopped long-think task" }),
  })
}

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback
  const row = value as Record<string, unknown>
  if (typeof row.message === "string") return row.message
  if (row.error && typeof row.error === "object" && !Array.isArray(row.error)) {
    const error = row.error as Record<string, unknown>
    if (typeof error.message === "string") return error.message
  }
  return fallback
}

export async function deleteLongThinkTask(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`/api/long-think/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      cache: "no-store",
    })
    const body = await response.json().catch(() => null) as { deleted?: boolean } | null
    if (response.ok && body?.deleted === true) {
      markDeleted(jobId)
      return
    }
    if (response.status === 202) {
      await new Promise(resolve => window.setTimeout(resolve, 500))
      continue
    }
    throw new Error(errorMessage(body, `删除失败（${response.status}）`))
  }
  throw new Error("任务正在停止，删除超时，请稍后再点一次删除")
}

export function useLongThinkJob() {
  const [activeJobId, setActiveJobId] = useState("")
  const [job, setJob] = useState<JobSnapshot | null>(null)
  const [jobs, setJobs] = useState<ListedJob[]>([])
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])

  const refreshJobs = useCallback(async () => { setJobs(await loadLongThinkJobs()) }, [])
  const refreshEndpoints = useCallback(async () => { setEndpoints(await loadLongThinkEndpoints()) }, [])
  const selectJob = useCallback((id: string) => {
    setActiveJobId(id)
    if (id) {
      setJob(cachedSnapshot(id))
      window.localStorage.setItem(STORAGE_KEY, id)
    } else {
      setJob(null)
      window.localStorage.removeItem(STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    const remembered = window.localStorage.getItem(STORAGE_KEY) ?? ""
    if (remembered && !deletedIds().has(remembered)) {
      setActiveJobId(remembered)
      setJob(cachedSnapshot(remembered))
    }
    void refreshJobs().catch(() => undefined)
    void refreshEndpoints().catch(() => undefined)
  }, [refreshEndpoints, refreshJobs])

  useEffect(() => {
    if (!activeJobId) return
    const listed = jobs.find(item => item.id === activeJobId)
    if (!listed) return
    const snapshot = listedToSnapshot(listed)
    writeSnapshot(snapshot)
    setJob(current => newerSnapshot(current, snapshot))
  }, [activeJobId, jobs])

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshJobs().catch(() => undefined) }, 1500)
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
        setJob(current => newerSnapshot(current, snapshot))
        if (ACTIVE.has(snapshot.status)) timer = window.setTimeout(poll, 1000)
        else void refreshJobs().catch(() => undefined)
      } catch { if (!cancelled) timer = window.setTimeout(poll, 2000) }
    }
    void poll()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [activeJobId, refreshJobs])

  return { activeJobId, job, jobs, endpoints, selectJob, refreshJobs, refreshEndpoints }
}
