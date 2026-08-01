import type { ChatRegenerationAuthority } from '@/lib/llm/chat-request'
import { persistJobPayload, removeJobPayload, type JobPayloadReference } from '@/lib/jobs/payload-storage'
import { createAdminClient } from '@/lib/supabase/admin'
import { isJobIdentifier, isJobStatus, type JobStatus, type JsonObject } from '@/lib/jobs/contracts'
import { jobMetrics } from '@/lib/observability/job-metrics'
import { log } from '@/lib/logger'
import { isRecord } from '@/lib/unknown-value'
import { JobRuntimeError } from '@/lib/jobs/errors'
import { sha256JobValue } from '@/lib/jobs/canonical'
import { loadRegenerationCleanupKeys } from './regeneration-cleanup'
import { enqueueDirectTurn, requiredAdminClient } from './direct-turn-admission'
import type { EnqueueChatJobInput } from './job-command-types'
import { referencesPayload, rpcObject, sanitizedAttachments } from './job-command-support'

export type { EnqueueChatJobInput } from './job-command-types'

const CHAT_POLICY_VERSION = '2026-08-01'
const REGENERATION_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 8_000] as const

type ChatJobAdmission = { id: string; status: JobStatus }
type AuthoritativeRpcResponse = { data: unknown; error: unknown }
type PreparedChatPayload = { mode: 'inline' | 'object'; reference: JobPayloadReference | null; stored: JsonObject }
type EnqueueChatJobDependencies = {
  persistPayload: typeof persistJobPayload
  removePayload: typeof removeJobPayload
  createAdminClient: typeof createAdminClient
  loadRegenerationCleanupKeys: typeof loadRegenerationCleanupKeys
  sleep: (milliseconds: number) => Promise<void>
}
const DEFAULT_DEPENDENCIES: EnqueueChatJobDependencies = { persistPayload: persistJobPayload, removePayload: removeJobPayload, createAdminClient, loadRegenerationCleanupKeys, sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }

function authoritativeDatabaseDetails(error: unknown): JsonObject {
  if (!isRecord(error)) return {}
  return { ...(typeof error.code === 'string' ? { databaseCode: error.code } : {}), ...(typeof error.message === 'string' ? { databaseMessage: error.message } : {}), ...(typeof error.details === 'string' ? { databaseDetails: error.details } : {}), ...(typeof error.hint === 'string' ? { databaseHint: error.hint } : {}), ...(typeof error.status === 'number' || typeof error.status === 'string' ? { status: error.status } : {}) }
}
function authoritativeRpcError(error: unknown, fallback: string): JobRuntimeError {
  const details = authoritativeDatabaseDetails(error)
  const code = typeof details.databaseCode === 'string' ? details.databaseCode : ''
  const databaseMessage = typeof details.databaseMessage === 'string' ? details.databaseMessage : ''
  const deterministicInfrastructure = ['42501', '42P01', '42703', '42883'].includes(code)
  const conflict = ['22023', '22P02', '23502', '23503', '23505', '23514', '40001', '54000', '55000'].includes(code)
  return new JobRuntimeError(conflict ? 'JOB_CONFLICT' : 'JOB_DEPENDENCY_UNAVAILABLE', databaseMessage ? `${fallback}${code ? ` (${code})` : ''}: ${databaseMessage}` : fallback, { retryable: !conflict && !deterministicInfrastructure, details })
}
function thrownAuthoritativeRpcError(error: unknown, fallback: string): JobRuntimeError { if (error instanceof JobRuntimeError) return error; return new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', fallback, { cause: error, details: { name: error instanceof Error ? error.name : 'unknown' } }) }
function parseJobAdmission(value: unknown, rpcName: string, expectedJobId: string): ChatJobAdmission {
  const source = rpcObject(value)
  if (!source || source.id !== expectedJobId || !isJobIdentifier(source.id) || !isJobStatus(source.status)) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Job admission response was malformed', { details: { rpc: rpcName, expectedJobId } })
  return { id: source.id, status: source.status }
}

async function callRegenerationRpc(input: { rpcName: string; fallback: string; jobId: string; invoke: () => PromiseLike<AuthoritativeRpcResponse>; sleep: EnqueueChatJobDependencies['sleep'] }): Promise<{ created: boolean; job: ChatJobAdmission }> {
  let lastError: JobRuntimeError | null = null
  for (let attempt = 0; attempt <= REGENERATION_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await input.invoke()
      const result = rpcObject(response.data)
      if (response.error || (result?.enqueued !== true && result?.replayed !== true)) throw authoritativeRpcError(response.error, input.fallback)
      return { created: result.enqueued === true && result.replayed !== true, job: parseJobAdmission(result.job, input.rpcName, input.jobId) }
    } catch (error) {
      const normalized = thrownAuthoritativeRpcError(error, input.fallback)
      if (!normalized.retryable) throw normalized
      lastError = normalized
    }
    const delayMs = REGENERATION_RETRY_DELAYS_MS[attempt]
    if (delayMs === undefined) break
    await input.sleep(delayMs)
  }
  throw lastError ?? new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', input.fallback)
}

async function enqueueAuthoritativeRegeneration(input: { client: NonNullable<ReturnType<typeof createAdminClient>>; command: EnqueueChatJobInput; authority: ChatRegenerationAuthority; payload: JsonObject; budget: JsonObject; queue: string; maxAttempts: number; loadCleanupKeys: typeof loadRegenerationCleanupKeys; sleep: EnqueueChatJobDependencies['sleep'] }): Promise<{ created: boolean; job: ChatJobAdmission }> {
  const { body } = input.command
  const userMessage = body.messages.find(message => message.id === body.userMessageId && message.role === 'user')
  if (!userMessage || typeof userMessage.content !== 'string') throw new JobRuntimeError('JOB_INVALID_INPUT', 'Authoritative regeneration source is incomplete')
  const userContent = userMessage.content
  const cleanupObjectKeys = await input.loadCleanupKeys({ client: input.client, userId: input.command.userId, conversationId: body.conversationId, sourceUserMessageId: body.userMessageId, authority: input.authority })
  return callRegenerationRpc({
    rpcName: 'enqueue_chat_regeneration_v1', fallback: 'Authoritative regeneration enqueue failed', jobId: body.generationId, sleep: input.sleep,
    invoke: () => input.client.rpc('enqueue_chat_regeneration_v1', {
      input_user_id: input.command.userId,
      input_conversation_id: body.conversationId,
      input_operation: input.authority.operation,
      input_source_user_message_id: body.userMessageId,
      input_target_assistant_message_id: input.authority.targetAssistantMessageId ?? null,
      input_expected_tail_message_id: input.authority.expectedTailMessageId,
      input_user_content: userContent,
      input_assistant_message_id: body.assistantMessageId,
      input_job_id: body.generationId,
      input_auth_class: input.command.isAnonymous ? 'anonymous' : 'registered',
      input_idempotency_key: `chat:${body.generationId}`,
      input_input_hash: String(input.payload.payloadHash),
      input_payload: input.payload,
      input_budget: input.budget,
      input_queue: input.queue,
      input_max_attempts: input.maxAttempts,
      input_cleanup_object_keys: cleanupObjectKeys,
    }) as unknown as PromiseLike<AuthoritativeRpcResponse>,
  })
}

async function admitChatJob(input: { command: EnqueueChatJobInput; dependencies: EnqueueChatJobDependencies; payload: JsonObject; budget: JsonObject; queue: string; maxAttempts: number }): Promise<{ created: boolean; job: ChatJobAdmission }> {
  const { body } = input.command
  const admin = input.dependencies.createAdminClient()
  if (body.turn.schemaVersion === 1) return enqueueDirectTurn({ client: requiredAdminClient(admin), body, userId: input.command.userId, isAnonymous: input.command.isAnonymous, requestedAt: input.command.requestedAt, payload: input.payload, budget: input.budget, queue: input.queue, maxAttempts: input.maxAttempts })
  return enqueueAuthoritativeRegeneration({ client: requiredAdminClient(admin), command: input.command, authority: body.turn, payload: input.payload, budget: input.budget, queue: input.queue, maxAttempts: input.maxAttempts, loadCleanupKeys: input.dependencies.loadRegenerationCleanupKeys, sleep: input.dependencies.sleep })
}

async function prepareChatPayload(input: { command: JsonObject; userId: string; jobId: string; outputKind: 'text' | 'image' | 'video'; billingClass: 'customer' | 'platform'; requestId: string; persistPayload: typeof persistJobPayload }): Promise<PreparedChatPayload> {
  const inputHash = sha256JobValue(input.command)
  const common: JsonObject = { schemaVersion: 2, payloadHash: inputHash, outputKind: input.outputKind, billingClass: input.billingClass, requestId: input.requestId }
  if (input.command.attachments === undefined) return { mode: 'inline', reference: null, stored: { ...common, command: input.command } }
  const reference = await input.persistPayload({ userId: input.userId, jobId: input.jobId, payload: input.command })
  return { mode: 'object', reference, stored: { ...common, payloadRef: reference.objectKey, payloadBytes: reference.bytes, payloadContentType: reference.contentType } }
}

async function compensateRejectedPayload(input: { dependencies: EnqueueChatJobDependencies; reference: JobPayloadReference; userId: string; jobId: string }): Promise<void> {
  const admin = input.dependencies.createAdminClient()
  let accepted: { data: unknown; error: unknown } | null = null
  try { accepted = admin ? await admin.from('jobs').select('id,payload').eq('id', input.jobId).maybeSingle() : null } catch { accepted = null }
  if (!accepted || accepted.error || referencesPayload(accepted.data, input.reference.objectKey) !== false) return
  try { await input.dependencies.removePayload(input.reference, { userId: input.userId, jobId: input.jobId }) } catch (cleanupError) { log.warn('jobs', 'Immediate orphan payload compensation failed', { jobId: input.jobId, name: cleanupError instanceof Error ? cleanupError.name : 'unknown' }) }
}

function resolvedAccessClass(value: EnqueueChatJobInput['accessClass']): NonNullable<EnqueueChatJobInput['accessClass']> {
  return value || 'legacy'
}

export async function enqueueChatJob(input: EnqueueChatJobInput, dependencyOverrides: Partial<EnqueueChatJobDependencies> = {}): Promise<{ created: boolean; job: ChatJobAdmission }> {
  const startedAt = Date.now()
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const { body } = input
  const accessClass = resolvedAccessClass(input.accessClass)
  const outputKind = input.outputKind === 'chat' ? 'text' : input.outputKind
  const attachments = sanitizedAttachments(body.attachments)
  const command: JsonObject = {
    schemaVersion: 1,
    policyVersion: CHAT_POLICY_VERSION,
    tier: body.tier ?? '绝句',
    ...(body.modelId ? { modelId: body.modelId } : {}),
    ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
    accessClass,
    searchMode: input.searchMode,
    historyRetrieval: body.historyRetrieval === true,
    renderEnabled: body.renderEnabled === true,
    usingBalance: input.usingBalance,
    outputKind,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    ...(body.endpointId ? { endpointId: body.endpointId } : {}),
    ...(attachments ? { attachments } : {}),
  }
  const prepared = await prepareChatPayload({ command, userId: input.userId, jobId: body.generationId, outputKind, billingClass: body.endpointId ? 'customer' : 'platform', requestId: input.requestId, persistPayload: dependencies.persistPayload })
  const payloadPreparedAt = Date.now()
  const queue = outputKind === 'text' ? 'chat' : 'media'
  const budget: JsonObject = outputKind === 'text' ? { wallTimeMs: 10 * 60_000, tokenLimit: accessClass === 'trial' ? 30_000 : 160_000, toolCallLimit: 64 } : { wallTimeMs: 15 * 60_000, costMicros: 50_000_000 }
  const maxAttempts = outputKind === 'text' ? 3 : 2
  let result: { created: boolean; job: ChatJobAdmission }
  try { result = await admitChatJob({ command: input, dependencies, payload: prepared.stored, budget, queue, maxAttempts }) } catch (error) { const reference = prepared.reference; if (!reference) throw error; await compensateRejectedPayload({ dependencies, reference, userId: input.userId, jobId: body.generationId }); throw error }
  if (result.created) jobMetrics.recordEnqueued(outputKind === 'text' ? 'chat_generation' : outputKind === 'image' ? 'media_image' : 'media_video')
  log.info('jobs', 'Chat job admission timing', { jobId: body.generationId, requestId: input.requestId, payloadMode: prepared.mode, payloadMs: payloadPreparedAt - startedAt, admissionMs: Date.now() - payloadPreparedAt, totalMs: Date.now() - startedAt })
  return result
}
