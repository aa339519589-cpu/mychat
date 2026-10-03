import type { Json, SupabaseClient } from '@/lib/supabase/types'
import type {
  ChatGPTPlanHistoryMessageInput,
  ChatGPTPlanHistoryPersistResult,
  ChatGPTPlanHistoryTurnInput,
} from '@/lib/chat/chatgpt-plan-history-contract'

type ExistingMessage = {
  id: string
  user_id: string
  conversation_id: string
  role: string
  content: string
  thinking: string | null
  images: Json | null
  content_parts: Json | null
  thinking_parts: Json | null
  media_refs: Json | null
  created_at: string
  seq: number
  status: string
  generation_id: string | null
}

type MessageWriteResult = 'inserted' | 'existing' | 'conflict' | 'unavailable'
type RegenerationStepResult = { kind: 'ready' } | Exclude<ChatGPTPlanHistoryPersistResult, { kind: 'persisted' }>
type RegenerationPreparation = RegenerationStepResult | { kind: 'already_saved' }

async function findExistingMessage(
  admin: SupabaseClient,
  messageId: string,
): Promise<ExistingMessage | null | { error: true; code?: string }> {
  const result = await admin.from('messages')
    .select('id,user_id,conversation_id,role,content,thinking,images,content_parts,thinking_parts,media_refs,created_at,seq,status,generation_id')
    .eq('id', messageId)
    .maybeSingle()
  if (result.error) return { error: true, code: result.error.code }
  return result.data as ExistingMessage | null
}

function expectedImages(message: ChatGPTPlanHistoryMessageInput): Json | null {
  return message.images.length ? { refs: message.images } as Json : null
}

function matchesCompletedMessage(
  existing: ExistingMessage,
  userId: string,
  conversationId: string,
  message: ChatGPTPlanHistoryMessageInput,
): boolean {
  return existing.user_id === userId
    && existing.conversation_id === conversationId
    && existing.role === message.role
    && existing.status === 'terminal'
    && existing.content === message.content
    && (existing.thinking ?? '') === (message.thinking ?? '')
    && JSON.stringify(existing.images ?? null) === JSON.stringify(expectedImages(message))
}

function isLegacyAssistantDraft(
  existing: ExistingMessage,
  userId: string,
  conversationId: string,
  messageId: string,
): boolean {
  const emptyParts = (parts: Json | null) => parts === null || (Array.isArray(parts) && parts.length === 0)
  const emptyMediaRefs = existing.media_refs === null
    || (Array.isArray(existing.media_refs) && existing.media_refs.length === 0)
  return existing.id === messageId
    && existing.user_id === userId
    && existing.conversation_id === conversationId
    && existing.role === 'assistant'
    && existing.status === 'draft'
    && existing.generation_id === null
    && existing.content === ''
    && (existing.thinking === null || existing.thinking === '')
    && existing.images === null
    && emptyParts(existing.content_parts)
    && emptyParts(existing.thinking_parts)
    && emptyMediaRefs
}

function messageRow(
  userId: string,
  conversationId: string,
  message: ChatGPTPlanHistoryMessageInput,
) {
  const contentParts: Json = message.content ? [{ type: 'text', text: message.content }] : []
  const thinkingParts: Json = message.thinking ? [{ type: 'text', text: message.thinking }] : []
  const images = expectedImages(message)
  return {
    id: message.id,
    user_id: userId,
    conversation_id: conversationId,
    role: message.role,
    content: message.content,
    thinking: message.thinking ?? null,
    images,
    content_parts: contentParts,
    thinking_parts: thinkingParts,
    media_refs: message.images as unknown as Json,
    created_at: message.createdAt,
    seq: 1,
    status: 'terminal',
    identity_locked: true,
    content_hash: '',
  }
}

async function adoptLegacyAssistantDraft(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  existing: ExistingMessage,
  message: ChatGPTPlanHistoryMessageInput,
): Promise<MessageWriteResult> {
  if (!isLegacyAssistantDraft(existing, userId, conversationId, message.id)) return 'conflict'
  const completed = messageRow(userId, conversationId, message)
  const finalized = await admin.from('messages').update({
    content: completed.content,
    thinking: completed.thinking,
    images: completed.images,
    content_parts: completed.content_parts,
    thinking_parts: completed.thinking_parts,
    media_refs: completed.media_refs,
    status: 'terminal',
  }).eq('id', message.id)
    .eq('user_id', userId)
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .eq('status', 'draft')
    .eq('content', '')
    .is('generation_id', null)
  if (finalized.error) return 'unavailable'

  const after = await findExistingMessage(admin, message.id)
  if (!after || 'error' in after) return 'unavailable'
  return matchesCompletedMessage(after, userId, conversationId, message) ? 'existing' : 'conflict'
}

async function settleExistingMessage(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  existing: ExistingMessage,
  message: ChatGPTPlanHistoryMessageInput,
): Promise<MessageWriteResult> {
  if (matchesCompletedMessage(existing, userId, conversationId, message)) return 'existing'
  if (message.role === 'assistant') {
    return adoptLegacyAssistantDraft(admin, userId, conversationId, existing, message)
  }
  return 'conflict'
}

async function persistMessageIdempotently(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  message: ChatGPTPlanHistoryMessageInput,
): Promise<MessageWriteResult> {
  const existing = await findExistingMessage(admin, message.id)
  if (existing && 'error' in existing) return 'unavailable'
  if (existing) return settleExistingMessage(admin, userId, conversationId, existing, message)

  const inserted = await admin.from('messages').insert(messageRow(userId, conversationId, message))
  if (!inserted.error) return 'inserted'
  if (inserted.error.code !== '23505') return 'unavailable'

  const raced = await findExistingMessage(admin, message.id)
  if (!raced || 'error' in raced) return 'unavailable'
  return settleExistingMessage(admin, userId, conversationId, raced, message)
}

async function verifyProjectOwnership(
  admin: SupabaseClient,
  userId: string,
  projectId: string | null,
): Promise<ChatGPTPlanHistoryPersistResult> {
  if (!projectId) return { kind: 'persisted' }
  const project = await admin.from('projects').select('id').eq('id', projectId).eq('user_id', userId).maybeSingle()
  if (project.error) return { kind: 'unavailable', code: project.error.code }
  return project.data ? { kind: 'persisted' } : { kind: 'not_found' }
}

async function ensureConversationOwnership(
  admin: SupabaseClient,
  userId: string,
  input: ChatGPTPlanHistoryTurnInput,
): Promise<ChatGPTPlanHistoryPersistResult> {
  const findConversation = () => admin.from('conversations').select('id,user_id')
    .eq('id', input.conversationId).maybeSingle()
  const prior = await findConversation()
  if (prior.error) return { kind: 'unavailable', code: prior.error.code }
  if (prior.data) return prior.data.user_id === userId ? { kind: 'persisted' } : { kind: 'not_found' }
  if (!input.createConversation) return { kind: 'not_found' }

  const inserted = await admin.from('conversations').insert({
    id: input.conversationId,
    user_id: userId,
    title: input.title,
    project_id: input.projectId,
  })
  if (inserted.error && inserted.error.code !== '23505') {
    return { kind: 'unavailable', code: inserted.error.code }
  }
  const verified = await findConversation()
  if (verified.error) return { kind: 'unavailable', code: verified.error.code }
  return verified.data?.user_id === userId ? { kind: 'persisted' } : { kind: 'not_found' }
}

async function deleteRegeneratedAssistant(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  assistantId: string,
): Promise<RegenerationStepResult> {
  const target = await findExistingMessage(admin, assistantId)
  if (target && 'error' in target) return { kind: 'unavailable', code: target.code }
  if (!target) return { kind: 'ready' }
  if (target.user_id !== userId || target.conversation_id !== conversationId
      || target.role !== 'assistant' || target.status !== 'terminal' || target.generation_id !== null) {
    return { kind: 'conflict' }
  }
  const deleted = await admin.from('messages').delete().eq('id', assistantId)
    .eq('conversation_id', conversationId).eq('user_id', userId).eq('status', 'terminal')
  return deleted.error ? { kind: 'unavailable', code: deleted.error.code } : { kind: 'ready' }
}

async function deleteMessagesAfterUser(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  userMessageId: string,
): Promise<RegenerationStepResult> {
  const source = await findExistingMessage(admin, userMessageId)
  if (!source || 'error' in source || source.role !== 'user'
      || source.user_id !== userId || source.conversation_id !== conversationId) return { kind: 'conflict' }
  const deleted = await admin.from('messages').delete()
    .eq('conversation_id', conversationId).eq('user_id', userId).gt('seq', source.seq)
  return deleted.error ? { kind: 'unavailable', code: deleted.error.code } : { kind: 'ready' }
}

async function removeLegacyRegenerationDraft(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  draft: ExistingMessage,
  message: ChatGPTPlanHistoryMessageInput,
): Promise<RegenerationStepResult | { kind: 'already_saved' }> {
  if (!isLegacyAssistantDraft(draft, userId, conversationId, message.id)) return { kind: 'conflict' }
  const deleted = await admin.from('messages').delete().eq('id', message.id)
    .eq('user_id', userId).eq('conversation_id', conversationId).eq('role', 'assistant')
    .eq('status', 'draft').eq('content', '').is('generation_id', null)
  if (deleted.error) return { kind: 'unavailable', code: deleted.error.code }
  const after = await findExistingMessage(admin, message.id)
  if (after && 'error' in after) return { kind: 'unavailable', code: after.code }
  if (!after) return { kind: 'ready' }
  if (matchesCompletedMessage(after, userId, conversationId, message)) return { kind: 'already_saved' }
  return { kind: 'conflict' }
}

async function prepareRegeneration(
  admin: SupabaseClient,
  userId: string,
  input: ChatGPTPlanHistoryTurnInput,
): Promise<RegenerationPreparation> {
  const regeneration = input.regeneration
  if (!regeneration) return { kind: 'ready' }

  const candidate = await findExistingMessage(admin, input.assistantMessage.id)
  if (candidate && 'error' in candidate) return { kind: 'unavailable', code: candidate.code }
  if (candidate) {
    if (matchesCompletedMessage(candidate, userId, input.conversationId, input.assistantMessage)) {
      return { kind: 'already_saved' }
    }
    const draftCleanup = await removeLegacyRegenerationDraft(
      admin, userId, input.conversationId, candidate, input.assistantMessage,
    )
    if (draftCleanup.kind !== 'ready') return draftCleanup
  }

  const tail = await admin.from('messages').select('id')
    .eq('conversation_id', input.conversationId).eq('user_id', userId)
    .order('seq', { ascending: false }).limit(1).maybeSingle()
  if (tail.error) return { kind: 'unavailable', code: tail.error.code }
  if (!tail.data || (tail.data.id !== regeneration.expectedTailMessageID
      && tail.data.id !== input.userMessage.id)) return { kind: 'conflict' }

  if (regeneration.operation === 'replace-assistant') {
    return deleteRegeneratedAssistant(
      admin, userId, input.conversationId, regeneration.targetAssistantMessageID!,
    )
  }
  return deleteMessagesAfterUser(admin, userId, input.conversationId, input.userMessage.id)
}

async function touchConversation(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
): Promise<ChatGPTPlanHistoryPersistResult> {
  const updated = await admin.from('conversations').update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId).eq('user_id', userId)
  return updated.error ? { kind: 'unavailable', code: updated.error.code } : { kind: 'persisted' }
}

function mapMessageWriteFailure(result: MessageWriteResult): ChatGPTPlanHistoryPersistResult | null {
  if (result === 'unavailable') return { kind: 'unavailable' }
  if (result === 'conflict') return { kind: 'conflict' }
  return null
}

export async function ensureChatGPTPlanHistoryUserMessage(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  message: ChatGPTPlanHistoryMessageInput,
): Promise<ChatGPTPlanHistoryPersistResult> {
  if (message.role !== 'user' || message.thinking) return { kind: 'conflict' }
  const result = await persistMessageIdempotently(admin, userId, conversationId, message)
  return mapMessageWriteFailure(result) ?? { kind: 'persisted' }
}

export async function persistChatGPTPlanHistoryTurn(
  admin: SupabaseClient,
  userId: string,
  input: ChatGPTPlanHistoryTurnInput,
): Promise<ChatGPTPlanHistoryPersistResult> {
  const project = await verifyProjectOwnership(admin, userId, input.projectId)
  if (project.kind !== 'persisted') return project
  const conversation = await ensureConversationOwnership(admin, userId, input)
  if (conversation.kind !== 'persisted') return conversation

  const userResult = await persistMessageIdempotently(admin, userId, input.conversationId, input.userMessage)
  const userFailure = mapMessageWriteFailure(userResult)
  if (userFailure) return userFailure

  const regeneration = await prepareRegeneration(admin, userId, input)
  if (regeneration.kind !== 'ready' && regeneration.kind !== 'already_saved') return regeneration
  if (regeneration.kind === 'already_saved') return touchConversation(admin, userId, input.conversationId)

  const assistantResult = await persistMessageIdempotently(
    admin, userId, input.conversationId, input.assistantMessage,
  )
  const assistantFailure = mapMessageWriteFailure(assistantResult)
  if (assistantFailure) return assistantFailure
  return touchConversation(admin, userId, input.conversationId)
}
