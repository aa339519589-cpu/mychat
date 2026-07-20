import type { Dispatch, SetStateAction } from 'react'
import type { Conversation } from '@/lib/chat-data'
import {
  applyConversationGenerationSnapshot,
  normalizeConversationGenerationSnapshot,
  toClientGenerationStatus,
  toGenerationTerminalSnapshot,
  type ClientGenerationPatch,
  type ConversationGenerationSnapshot,
} from '@/lib/generation-client'
import { cacheGenerationTerminal } from '@/lib/data'
import { normalizeGeneratedMedia, normalizeGeneratedMediaList, type GeneratedMedia } from '@/lib/generated-media'
import { isRecord } from '@/lib/unknown-value'
import { enqueueJobUntilAccepted } from './durable-job-enqueue'
import { streamJobEvents, type AcceptedJob } from './job-stream-client'
import { fetchJsonWithTimeout } from './timed-json-fetch'
import {
  pendingGenerationId,
  pendingSubmissionBody,
  readPendingChatSubmission,
  removePendingChatSubmission,
  removePermanentlyRejectedSubmission,
  type PendingChatSubmission,
} from './pending-chat-submission'

type ConversationSetter = Dispatch<SetStateAction<Conversation[]>>
type MarkGeneration = (conversationId: string, patch: ClientGenerationPatch) => void

type ResumeJob = {
  id: string
  status: string
  subject: Record<string, unknown>
  progress: Record<string, unknown>
  result: unknown
  errorCode: string | null
  eventSequence: number
}

function parseJob(value: unknown): ResumeJob | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.status !== 'string'
    || !isRecord(value.subject) || !isRecord(value.progress)
    || !Number.isSafeInteger(value.eventSequence)
    || (value.errorCode !== null && typeof value.errorCode !== 'string')) return null
  return {
    id: value.id,
    status: value.status,
    subject: value.subject,
    progress: value.progress,
    result: value.result,
    errorCode: value.errorCode,
    eventSequence: Number(value.eventSequence),
  }
}

function terminal(status: string): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/**
 * A browser can lose an enqueue acknowledgement after the database accepted
 * it. Before replacing a branch, check for that still-running authoritative
 * job so a second regeneration does not conflict with the first one.
 */
export async function hasActiveConversationGeneration(
  conversationId: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (await readPendingChatSubmission(conversationId)) return true
  try {
    const response = await fetcher(`/api/v1/conversations/${encodeURIComponent(conversationId)}/generation`)
    if (!response.ok) return false
    const body: unknown = await response.json()
    if (!isRecord(body)) return false
    const job = parseJob(body.job)
    return job !== null && !terminal(job.status)
  } catch {
    // This is only a duplicate-submission guard. Do not turn a read outage
    // into an admission outage; the fenced enqueue RPC remains authoritative.
    return false
  }
}

async function queryConversationGeneration(conversationId: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  try {
    const { response, payload } = await fetchJsonWithTimeout(
      fetch,
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/generation`,
      { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } },
      controller.signal,
      10_000,
    )
    return response.ok && isRecord(payload) ? payload : null
  } catch {
    return null
  }
}

function snapshotFromJob(job: ResumeJob, conversationId: string): ConversationGenerationSnapshot | null {
  const result = isRecord(job.result) ? job.result : {}
  const source = { ...job.progress, ...result }
  return normalizeConversationGenerationSnapshot({
    id: job.id,
    conversationId,
    assistantMessageId: job.subject.assistantMessageId,
    status: terminal(job.status) ? job.status : job.status === 'queued' ? 'queued' : 'running',
    content: typeof source.content === 'string' ? source.content : '',
    thinking: typeof source.thinking === 'string' ? source.thinking : '',
    media: Array.isArray(source.media) ? source.media : [],
    sequence: job.eventSequence,
    error: job.errorCode,
  })
}

function applySnapshot(
  setConversations: ConversationSetter,
  conversationId: string,
  snapshot: ConversationGenerationSnapshot,
) {
  setConversations(previous => applyConversationGenerationSnapshot(previous, conversationId, snapshot))
}

async function applyTerminal(options: {
  conversationId: string
  snapshot: ConversationGenerationSnapshot
  setConversations: ConversationSetter
  markGeneration: MarkGeneration
}) {
  const terminalSnapshot = toGenerationTerminalSnapshot(options.snapshot)
  if (!terminalSnapshot) return false
  applySnapshot(options.setConversations, options.conversationId, options.snapshot)
  await cacheGenerationTerminal(options.conversationId, options.snapshot.assistantMessageId, {
    ...terminalSnapshot,
    generationId: options.snapshot.id,
  }).catch(() => undefined)
  options.markGeneration(options.conversationId, {
    status: toClientGenerationStatus(options.snapshot.status),
    generationId: options.snapshot.id,
    assistantMessageId: options.snapshot.assistantMessageId,
    authoritativeTerminal: true,
  })
  return true
}

function markWarning(
  setConversations: ConversationSetter,
  conversationId: string,
  assistantMessageId: string,
  warning = '生成状态连接已中断；当前内容已保留，重新打开会话可再次同步。',
) {
  setConversations(previous => previous.map(conversation => conversation.id !== conversationId
    ? conversation
    : {
      ...conversation,
      messages: conversation.messages.map(message => message.id !== assistantMessageId
        ? message
        : { ...message, outputWarning: warning }),
    }))
}

function initialPendingSnapshot(
  submission: PendingChatSubmission,
  accepted: AcceptedJob,
): ConversationGenerationSnapshot {
  return {
    id: accepted.jobId,
    conversationId: submission.conversationId,
    assistantMessageId: submission.assistantMessageId,
    status: accepted.status === 'queued' ? 'queued' : 'running',
    content: '',
    thinking: '',
    media: [],
    sequence: 0,
    error: null,
  }
}

async function consumeGenerationStream(options: {
  accepted: AcceptedJob
  initial: ConversationGenerationSnapshot
  controller: AbortController
  setConversations: ConversationSetter
  markGeneration: MarkGeneration
}) {
  const { accepted, initial, controller, setConversations, markGeneration } = options
  let content = ''
  let thinking = ''
  const media: GeneratedMedia[] = []
  for await (const event of streamJobEvents(accepted, controller.signal)) {
    if (event.kind === 'job.retry_scheduled'
      || (event.kind === 'job.leased'
        && typeof event.payload.attempt === 'number' && event.payload.attempt > 1)) {
      content = ''
      thinking = ''
      media.splice(0, media.length)
    }
    if (event.kind === 'text.delta' && typeof event.payload.text === 'string') {
      content += event.payload.text
    } else if (event.kind === 'thinking.delta' && typeof event.payload.thinking === 'string') {
      thinking += event.payload.thinking
    } else if (event.kind === 'media.uploaded') {
      const item = normalizeGeneratedMedia(event.payload.media)
      if (item && !media.some(existing => existing.type === item.type && existing.url === item.url)) media.push(item)
    }
    if (event.kind === 'job.terminal') {
      const result = isRecord(event.payload.result) ? event.payload.result : {}
      const snapshot = normalizeConversationGenerationSnapshot({
        id: accepted.jobId,
        conversationId: initial.conversationId,
        assistantMessageId: initial.assistantMessageId,
        status: event.payload.status,
        content: typeof result.content === 'string' ? result.content : content,
        thinking: typeof result.thinking === 'string' ? result.thinking : thinking,
        media: Array.isArray(result.media) ? normalizeGeneratedMediaList(result.media) : media,
        sequence: event.seq,
        error: typeof event.payload.errorCode === 'string' ? event.payload.errorCode : null,
      })
      if (!snapshot || !(await applyTerminal({
        conversationId: initial.conversationId,
        snapshot,
        setConversations,
        markGeneration,
      }))) throw new Error('generation_terminal_invalid')
      return
    }
    applySnapshot(setConversations, initial.conversationId, {
      ...initial,
      status: 'running',
      content,
      thinking,
      media: [...media],
      sequence: event.seq,
      error: null,
    })
  }
  throw new Error('generation_terminal_missing')
}

export async function resumeConversationGeneration(options: {
  conversationId: string
  setConversations: ConversationSetter
  markGeneration: MarkGeneration
  registerAbort: (conversationId: string, controller: AbortController) => void
  clearAbort: (conversationId: string, controller: AbortController) => void
  onReconciled?: (available: boolean) => void
}) {
  const { conversationId, setConversations, markGeneration, registerAbort, clearAbort } = options
  let controller: AbortController | null = null; let activeIdentity: { id: string; assistantMessageId: string } | null = null
  let reconciled = false
  const report = (available: boolean) => {
    if (reconciled) return
    reconciled = true
    options.onReconciled?.(available)
  }
  try {
    const pendingBeforeQuery = await readPendingChatSubmission(conversationId)
    const body = await queryConversationGeneration(conversationId)
    if (!body && !pendingBeforeQuery) throw new Error('generation_query_unavailable')
    if (!body || (body.job === null && body.streamUrl === null)) {
      const pending = pendingBeforeQuery ?? await readPendingChatSubmission(conversationId)
      const pendingBody = pending ? pendingSubmissionBody(pending) : null
      if (!pending || !pendingBody) {
        if (pending) await removePendingChatSubmission(conversationId, pending.generationId)
        report(true)
        return
      }
      activeIdentity = { id: pending.generationId, assistantMessageId: pending.assistantMessageId }
      markGeneration(conversationId, {
        status: 'running',
        generationId: pending.generationId,
        assistantMessageId: pending.assistantMessageId,
        begin: true,
      })
      report(true)
      controller = new AbortController()
      registerAbort(conversationId, controller)
      const accepted = await enqueueJobUntilAccepted(
        pending.path,
        pendingBody,
        controller.signal,
        () => markWarning(
          setConversations,
          conversationId,
          pending.assistantMessageId,
          '消息已保存；连接恢复后会自动继续，无需重新发送。',
        ),
      )
      await removePendingChatSubmission(conversationId, pending.generationId)
      const initial = initialPendingSnapshot(pending, accepted)
      applySnapshot(setConversations, conversationId, initial)
      setConversations(previous => previous.map(conversation => conversation.id === conversationId
        ? { ...conversation, draft: false }
        : conversation))
      await consumeGenerationStream({ accepted, initial, controller, setConversations, markGeneration })
      return
    }
    const job = parseJob(body.job)
    if (!job || typeof body.streamUrl !== 'string') throw new Error('generation_job_invalid')
    const initial = snapshotFromJob(job, conversationId)
    if (!initial || initial.conversationId !== conversationId) throw new Error('generation_identity_invalid')
    activeIdentity = { id: job.id, assistantMessageId: initial.assistantMessageId }
    await removePendingChatSubmission(conversationId, pendingGenerationId(pendingBeforeQuery, job.id))
    if (terminal(job.status)) {
      await applyTerminal({ conversationId, snapshot: initial, setConversations, markGeneration })
      report(true)
      return
    }

    markGeneration(conversationId, {
      status: 'running',
      generationId: job.id,
      assistantMessageId: initial.assistantMessageId,
      begin: true,
    })
    report(true)
    controller = new AbortController()
    registerAbort(conversationId, controller)
    await consumeGenerationStream({
      accepted: {
        jobId: job.id,
        status: job.status,
        streamUrl: body.streamUrl,
      },
      initial,
      controller,
      setConversations,
      markGeneration,
    })
  } catch (error) {
    if (controller?.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return
    await removePermanentlyRejectedSubmission(conversationId, activeIdentity, error)
    const response = error instanceof Error ? error.message : 'unknown'
    console.warn('resumeConversationGeneration', response)
    if (activeIdentity) {
      markGeneration(conversationId, {
        status: 'error',
        generationId: activeIdentity.id,
        assistantMessageId: activeIdentity.assistantMessageId,
      })
      markWarning(setConversations, conversationId, activeIdentity.assistantMessageId)
    }
    // A status endpoint outage is not a reason to keep the whole composer locked.
    // Fresh history remains usable and the next activation will attempt reconciliation again.
    report(true)
  } finally {
    if (controller) clearAbort(conversationId, controller)
  }
}
