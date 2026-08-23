import { createAdminClient } from '@/lib/supabase/admin'
import { sha256JobValue } from '@/lib/jobs/canonical'
import { readOwnedJob } from '@/lib/jobs/read-model'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import type { JobAuthClass, JsonObject, JsonValue } from '@/lib/jobs/contracts'
import type { LongThinkCompletion, LongThinkMessage } from '@/lib/long-think/provider'
import { chatGptBridgeQueue } from './queue'

const POLL_MS = 1_000
const WAIT_LIMIT_MS = 30 * 60 * 1_000

export class ChatGptBridgeError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable = true) {
    super(message)
    this.name = 'ChatGptBridgeError'
    this.retryable = retryable
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    const aborted = () => done(signal.reason)
    function done(error?: unknown) {
      clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      if (error !== undefined) reject(error)
      else resolve()
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function asObject(value: JsonValue | null): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function nullableToken(value: JsonValue | undefined): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function completionFrom(value: JsonValue | null): LongThinkCompletion | null {
  const row = asObject(value)
  if (!row || typeof row.text !== 'string') return null
  const usage = asObject(row.usage ?? null)
  return {
    text: row.text,
    reasoning: typeof row.reasoning === 'string' ? row.reasoning : '',
    finishReason: typeof row.finishReason === 'string' ? row.finishReason : null,
    usage: {
      inputTokens: nullableToken(usage?.inputTokens),
      outputTokens: nullableToken(usage?.outputTokens),
    },
  }
}

function childInput(parentJobId: string, purpose: string, messages: readonly LongThinkMessage[], maxTokens: number): JsonObject {
  return {
    parentJobId,
    purpose,
    maxTokens,
    messages: messages.map(message => ({ role: message.role, content: message.content })),
  }
}

async function waitForChild(
  principalId: string,
  jobId: string,
  signal: AbortSignal,
): Promise<LongThinkCompletion> {
  const admin = createAdminClient()
  if (!admin) throw new ChatGptBridgeError('ChatGPT bridge storage is unavailable')
  const deadline = Date.now() + WAIT_LIMIT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason
    const read = await readOwnedJob(admin, principalId, jobId, signal)
    if (!read.ok) {
      if (read.kind === 'not_found') throw new ChatGptBridgeError('ChatGPT bridge turn disappeared')
      await sleep(POLL_MS, signal)
      continue
    }
    if (read.value.status === 'completed') {
      const completion = completionFrom(read.value.result)
      if (!completion) throw new ChatGptBridgeError('ChatGPT bridge returned an invalid result')
      return completion
    }
    if (read.value.status === 'failed') {
      throw new ChatGptBridgeError(`ChatGPT bridge turn failed (${read.value.errorCode ?? 'unknown'})`)
    }
    if (read.value.status === 'cancelled') throw new ChatGptBridgeError('ChatGPT bridge turn was cancelled')
    await sleep(POLL_MS, signal)
  }
  throw new ChatGptBridgeError('ChatGPT browser bridge did not answer within 30 minutes')
}

export async function chatGptSubscriptionCompletion(options: {
  parentJobId: string
  principalId: string
  authClass: JobAuthClass
  purpose: string
  messages: readonly LongThinkMessage[]
  maxTokens: number
  signal: AbortSignal
}): Promise<LongThinkCompletion> {
  const repository = new SupabaseJobRepository()
  const input = childInput(options.parentJobId, options.purpose, options.messages, options.maxTokens)
  const enqueued = await repository.enqueue({
    jobId: crypto.randomUUID(),
    type: 'chatgpt.web.turn',
    queue: chatGptBridgeQueue(options.principalId),
    principal: { id: options.principalId, authClass: options.authClass },
    subject: {
      feature: 'chatgpt-subscription-bridge',
      parentJobId: options.parentJobId,
      purpose: options.purpose,
    },
    idempotencyKey: `chatgpt-web:${options.parentJobId}:${options.purpose}`,
    inputHash: sha256JobValue(input),
    input,
    maxAttempts: 50,
    priority: -20,
  })
  return waitForChild(options.principalId, enqueued.job.id, options.signal)
}
