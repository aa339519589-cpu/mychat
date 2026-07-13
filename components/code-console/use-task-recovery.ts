"use client"

import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { shouldShowWorkspacePublish } from '@/lib/code-agent-ui'
import type { CodeMessage } from '@/lib/code-data'
import { streamJobEvents, type AcceptedJob } from '@/components/literary-chat/job-stream-client'
import { applyCodeJobEnvelope } from './job-events'
import { initialCodeStreamState } from './stream'

export type RunCodeSendOptions = {
  internal?: boolean
  baseMessages?: CodeMessage[]
  repo?: string | null
  taskId?: string
  sessionId?: string | null
}

export type RunCodeSend = (text: string, options?: RunCodeSendOptions) => Promise<void>

type TaskJob = AcceptedJob & { responseId: string }

function activeJob(value: unknown): TaskJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const active = new Set(['queued', 'leased', 'running', 'awaiting_input', 'cancelling'])
  if (typeof source.id !== 'string' || typeof source.streamUrl !== 'string'
    || typeof source.status !== 'string' || !active.has(source.status)
    || typeof source.responseId !== 'string') return null
  return {
    jobId: source.id,
    streamUrl: source.streamUrl,
    status: source.status,
    responseId: source.responseId,
  }
}

export function useTaskRecovery(options: {
  messages: CodeMessage[]
  abortRef: MutableRefObject<AbortController | null>
  setMessages: Dispatch<SetStateAction<CodeMessage[]>>
  setStreaming: Dispatch<SetStateAction<boolean>>
  setCurrentTaskId: Dispatch<SetStateAction<string | null>>
  setWorkspaceDirty: Dispatch<SetStateAction<boolean>>
  setPublishPending: Dispatch<SetStateAction<boolean>>
}) {
  const abortRef = options.abortRef
  const attachedJobs = useRef(new Set<string>())

  useEffect(() => () => abortRef.current?.abort(), [abortRef])

  async function syncWorkspaceState(taskId: string, knownMessages = options.messages) {
    try {
      const [gitResponse, detailResponse] = await Promise.all([
        fetch(`/api/agent/tasks/${taskId}/workspace/git`),
        fetch(`/api/agent/tasks/${taskId}`),
      ])
      const hasChanges = gitResponse.ok ? !!(await gitResponse.json()).hasChanges : false
      options.setWorkspaceDirty(hasChanges)
      const task = detailResponse.ok ? await detailResponse.json() as {
        status?: string | null
        pullRequestUrl?: string | null
        steps?: { kind?: string | null; label?: string | null }[]
      } : null
      options.setPublishPending(shouldShowWorkspacePublish(task, knownMessages, hasChanges))
    } catch (error) {
      console.warn('[CodeConsole] workspace state sync failed (non-blocking)', error)
    }
  }

  function attach(taskId: string, job: TaskJob) {
    if (attachedJobs.current.has(job.jobId)) return
    attachedJobs.current.add(job.jobId)
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    options.setStreaming(true)
    let state = initialCodeStreamState(taskId)
    void (async () => {
      try {
        for await (const envelope of streamJobEvents(job, controller.signal, 50 * 60_000)) {
          state = applyCodeJobEnvelope(state, envelope)
          options.setMessages(current => current.map(message => message.id === job.responseId ? {
            ...message,
            content: state.fullText,
            steps: state.steps,
            plan: state.plan,
            taskId,
            isError: state.hadError || undefined,
          } : message))
          if (state.publishPending) options.setPublishPending(true)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error('[CodeConsole] durable job reattach failed', error)
      } finally {
        attachedJobs.current.delete(job.jobId)
        if (abortRef.current === controller) abortRef.current = null
        options.setStreaming(false)
        await syncWorkspaceState(taskId)
      }
    })()
  }

  async function restoreTask(repo: string, messages: CodeMessage[], _sessionId: string | null) {
    const savedTaskId = [...messages].reverse().find(message => message.taskId)?.taskId
    try {
      const response = await fetch(`/api/agent/tasks?repo=${encodeURIComponent(repo)}`)
      if (!response.ok) return
      const tasks = await response.json() as { id: string; status: string }[]
      const active = new Set(['queued', 'planning', 'editing', 'running', 'waiting_for_user', 'creating_pr'])
      const task = tasks.find(item => item.id === savedTaskId && active.has(item.status))
        ?? tasks.find(item => active.has(item.status))
      if (!task) return
      options.setCurrentTaskId(task.id)
      await syncWorkspaceState(task.id, messages)
      const detailResponse = await fetch(`/api/agent/tasks/${task.id}`)
      if (!detailResponse.ok) return
      const detail = await detailResponse.json() as { job?: unknown }
      const job = activeJob(detail.job)
      if (job) attach(task.id, job)
    } catch {
      // Reattachment is best-effort; the database remains authoritative.
    }
  }

  return { restoreTask, syncWorkspaceState }
}
