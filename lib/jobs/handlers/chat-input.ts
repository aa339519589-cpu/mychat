import type { SupabaseClient } from '@/lib/supabase/types'
import type { SupabaseServer } from '@/lib/api/guard'
import { AuthoritativeContextError, loadAuthoritativeChatContext } from '@/lib/chat/authoritative-context'
import { ChatModelSelectionError, resolveChatModelSelection, type ChatModelSelection } from '@/lib/chat/model-selection'
import type { ModelAccessClass } from '@/lib/model-catalog'
import type { SearchMode } from '@/lib/chat/request-context'
import { loadCustomSystemPrompt } from '@/lib/chat/user-system-prompt'
import type { Attachment } from '@/lib/llm/types'
import { log } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import { sha256JobValue } from '../canonical'
import { loadJobPayload, type JobPayloadReference } from '../payload-storage'
import { isJsonValue, type JobRecord, type JsonObject } from '../contracts'
import { JobRuntimeError } from '../errors'

export type LoadedChatJob = {
  client: SupabaseClient
  userId: string
  conversationId: string
  userMessageId: string
  assistantMessageId: string
  command: {
    tier: string
    modelId?: string
    reasoningEffort?: string
    accessClass: ModelAccessClass | 'legacy'
    endpointId?: string
    searchMode: SearchMode
    historyRetrieval: boolean
    connectorIds?: string[]
    connectorAccessMode: 'auto' | 'always_available' | 'on_demand'
    renderEnabled: boolean
    renderProfile?: 'native-v1'
    usingBalance: boolean
    outputKind: 'text' | 'image' | 'video'
    attachments?: Attachment[]
  }
  context: Awaited<ReturnType<typeof loadAuthoritativeChatContext>> & { customSystemPrompt: string }
  selection: ChatModelSelection
}

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function identity(job: JobRecord, field: string): string { const value = job.subject[field]; if (typeof value !== 'string') throw new JobRuntimeError('JOB_INVALID_INPUT', `Missing ${field}`); return value }
function reference(job: JobRecord): JobPayloadReference {
  const input = record(job.input); const nested = record(input?.payloadRef)
  if (nested) return nested as JobPayloadReference
  if (typeof input?.payloadRef !== 'string' || typeof input.payloadHash !== 'string' || !Number.isSafeInteger(input.payloadBytes) || input.payloadContentType !== 'application/json') throw new JobRuntimeError('JOB_INVALID_INPUT', 'Job payload reference is invalid')
  return { bucket: 'job-payloads', objectKey: input.payloadRef, sha256: input.payloadHash, bytes: Number(input.payloadBytes), contentType: 'application/json' }
}
function embeddedCommand(job: JobRecord): JsonObject | null {
  const input = record(job.input)
  if (!input) throw new JobRuntimeError('JOB_INVALID_INPUT', 'Chat job input is invalid')
  const value = record(input.command)
  if (!value) return null
  if (input.payloadRef !== undefined || typeof input.payloadHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.payloadHash) || !isJsonValue(value) || sha256JobValue(value) !== input.payloadHash) throw new JobRuntimeError('JOB_INVALID_INPUT', 'Inline chat command integrity failed')
  return value
}
async function loadCommandPayload(job: JobRecord, scope: { userId: string; jobId: string }): Promise<{ payload: JsonObject; mode: 'inline' | 'object' }> {
  const inline = embeddedCommand(job)
  return inline ? { payload: inline, mode: 'inline' } : { payload: await loadJobPayload(reference(job), scope), mode: 'object' }
}
function attachments(value: unknown): Attachment[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 8) throw new JobRuntimeError('JOB_INVALID_INPUT', 'Job attachments are invalid')
  return value.map(item => {
    const source = record(item)
    if (!source || typeof source.name !== 'string' || typeof source.dataUrl !== 'string' || typeof source.isPdf !== 'boolean' || (source.text !== undefined && typeof source.text !== 'string') || (source.pageImages !== undefined && (!Array.isArray(source.pageImages) || source.pageImages.some(image => typeof image !== 'string')))) throw new JobRuntimeError('JOB_INVALID_INPUT', 'Job attachment is malformed')
    return { name: source.name, dataUrl: source.dataUrl, isPdf: source.isPdf, ...(typeof source.text === 'string' ? { text: source.text } : {}), ...(Array.isArray(source.pageImages) ? { pageImages: source.pageImages as string[] } : {}) }
  })
}
function accessClass(value: unknown): ModelAccessClass | 'legacy' {
  if (value === undefined) return 'legacy'
  if (value === 'quota' || value === 'trial' || value === 'premium' || value === 'legacy') return value
  throw new JobRuntimeError('JOB_INVALID_INPUT', 'Chat model access class is malformed')
}
function connectorIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!Array.isArray(value) || value.length > 10
    || !value.every((item): item is string => typeof item === 'string' && uuid.test(item))
    || new Set(value.map(item => typeof item === 'string' ? item.toLowerCase() : item)).size !== value.length) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Chat connector selection is malformed')
  }
  return value.map(item => item.toLowerCase())
}
function connectorAccessMode(value: unknown): LoadedChatJob['command']['connectorAccessMode'] {
  if (value === undefined) return 'always_available'
  if (value === 'auto' || value === 'always_available' || value === 'on_demand') return value
  throw new JobRuntimeError('JOB_INVALID_INPUT', 'Chat connector access mode is malformed')
}

function validOutputFields(value: JsonObject): boolean {
  return (value.outputKind === 'text' || value.outputKind === 'image' || value.outputKind === 'video')
    && (value.searchMode === 'off' || value.searchMode === 'web')
    && typeof value.historyRetrieval === 'boolean'
    && typeof value.renderEnabled === 'boolean'
    && (value.renderProfile === undefined || value.renderProfile === 'native-v1')
    && typeof value.usingBalance === 'boolean'
}

function validOptionalStringFields(value: JsonObject): boolean {
  return (value.endpointId === undefined || typeof value.endpointId === 'string')
    && (value.modelId === undefined || typeof value.modelId === 'string')
    && (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
}

function validateCommand(value: JsonObject): void {
  if (typeof value.tier !== 'string' || !validOutputFields(value) || !validOptionalStringFields(value)) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Chat job command is malformed')
  }
}

function optionalCommandValues(value: JsonObject): Pick<LoadedChatJob['command'],
  'modelId' | 'reasoningEffort' | 'endpointId' | 'attachments' | 'connectorIds'> {
  return {
    ...(typeof value.modelId === 'string' ? { modelId: value.modelId } : {}),
    ...(typeof value.reasoningEffort === 'string' ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(typeof value.endpointId === 'string' ? { endpointId: value.endpointId } : {}),
    ...(value.attachments !== undefined ? { attachments: attachments(value.attachments) } : {}),
    ...(value.connectorIds !== undefined ? { connectorIds: connectorIds(value.connectorIds) } : {}),
  }
}

function command(value: JsonObject): LoadedChatJob['command'] {
  validateCommand(value)
  return {
    tier: value.tier as string,
    outputKind: value.outputKind as 'text' | 'image' | 'video',
    searchMode: value.searchMode as SearchMode,
    historyRetrieval: value.historyRetrieval as boolean,
    connectorAccessMode: connectorAccessMode(value.connectorAccessMode),
    renderEnabled: value.renderEnabled as boolean,
    ...(value.renderProfile === 'native-v1' ? { renderProfile: value.renderProfile } : {}),
    usingBalance: value.usingBalance as boolean,
    accessClass: accessClass(value.accessClass),
    ...optionalCommandValues(value),
  }
}
function allowInstantContext(value: LoadedChatJob['command']): boolean { return value.outputKind === 'text' && value.searchMode === 'off' && !value.attachments?.length }

function normalizeChatLoadError(error: unknown): JobRuntimeError {
  if (error instanceof JobRuntimeError) return error
  if (error instanceof AuthoritativeContextError) {
    const code = error.code === 'CONTEXT_UNAVAILABLE' ? 'JOB_DEPENDENCY_UNAVAILABLE' : 'JOB_INVALID_INPUT'
    return new JobRuntimeError(code, error.message, { cause: error })
  }
  if (error instanceof ChatModelSelectionError) {
    return new JobRuntimeError('JOB_INVALID_INPUT', error.message, { cause: error, retryable: false })
  }
  return new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Chat policy is unavailable', { cause: error })
}

function assertSelectedChatPolicy(
  commandValue: LoadedChatJob['command'],
  selection: ChatModelSelection,
  billingClass: unknown,
): void {
  const selectedKind = selection.outputKind === 'chat' ? 'text' : selection.outputKind
  if (selectedKind !== commandValue.outputKind || selection.accessClass !== commandValue.accessClass) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Model policy changed after enqueue')
  }
  if ((billingClass === 'customer') !== selection.customEndpoint
    || (billingClass !== 'customer' && billingClass !== 'platform')) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Billing authority changed after enqueue')
  }
}

export async function loadChatJob(job: JobRecord): Promise<LoadedChatJob> {
  const startedAt = Date.now()
  let client: SupabaseClient | null
  try { client = createAdminClient() } catch (error) { throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable', { cause: error }) }
  if (!client) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable')
  const userId = job.principal.id; const conversationId = identity(job, 'conversationId'); const userMessageId = identity(job, 'userMessageId'); const assistantMessageId = identity(job, 'assistantMessageId')
  try {
    const loadedCommand = await loadCommandPayload(job, { userId, jobId: job.id })
    const payloadReadyAt = Date.now()
    const parsedCommand = command(loadedCommand.payload)
    const jobInput = record(job.input); const admission = record(jobInput?.admission); const billingClass = jobInput?.billingClass
    // Admission already authorized premium access at enqueue time. Worker must
    // re-resolve the same route with allowPremium, or every premium model fails
    // with 403 after the client already accepted the job.
    const [authoritativeContext, selection, customSystemPrompt] = await Promise.all([
      loadAuthoritativeChatContext({ client, userId, conversationId, userMessageId, allowInstant: allowInstantContext(parsedCommand) }),
      resolveChatModelSelection({
        tier: parsedCommand.tier,
        endpointId: parsedCommand.endpointId,
        modelId: parsedCommand.modelId,
        reasoningEffort: parsedCommand.reasoningEffort,
        supabase: client as unknown as SupabaseServer,
        userId,
        allowPremium: true,
      }),
      loadCustomSystemPrompt(client, userId),
    ])
    assertSelectedChatPolicy(parsedCommand, selection, billingClass)
    log.info('jobs', 'Chat job preparation timing', { jobId: job.id, payloadMode: loadedCommand.mode, payloadMs: payloadReadyAt - startedAt, contextPolicyAndPromptMs: Date.now() - payloadReadyAt, totalMs: Date.now() - startedAt })
    return { client, userId, conversationId, userMessageId, assistantMessageId, command: { ...parsedCommand, usingBalance: admission?.funding === 'balance' }, context: { ...authoritativeContext, customSystemPrompt }, selection }
  } catch (error) {
    throw normalizeChatLoadError(error)
  }
}
