import type { Json, SupabaseClient } from '@/lib/supabase/types'

export type ChatGPTPlanHistoryMessageInput = {
  id: string
  role: 'user' | 'assistant'
  content: string
  images: string[]
  createdAt: string
}

export type ChatGPTPlanHistoryTurnInput = {
  conversationId: string
  createConversation: boolean
  title: string
  projectId: string | null
  userMessage: ChatGPTPlanHistoryMessageInput
  assistantMessage: ChatGPTPlanHistoryMessageInput
  regeneration: {
    operation: 'replace-assistant' | 'replace-from-user'
    expectedTailMessageID: string
    targetAssistantMessageID: string | null
  } | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_CONTENT_BYTES = 262_144
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 4
const ALLOWED_MESSAGE_KEYS = new Set(['id', 'role', 'content', 'images', 'createdAt'])
const ALLOWED_KEYS = new Set([
  'conversationId', 'createConversation', 'title', 'projectId', 'userMessage', 'assistantMessage', 'regeneration',
])
const ALLOWED_REGENERATION_KEYS = new Set(['operation', 'expectedTailMessageID', 'targetAssistantMessageID'])

export class ChatGPTPlanHistoryInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatGPTPlanHistoryInputError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function isValidImage(value: unknown): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_IMAGE_BYTES) return false
  return value.startsWith('data:image/') || /^https:\/\//i.test(value)
}

function validateMessage(value: unknown, role: 'user' | 'assistant'): ChatGPTPlanHistoryMessageInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ALLOWED_MESSAGE_KEYS)
      || value.role !== role || !isUUID(value.id)) {
    throw new ChatGPTPlanHistoryInputError(`Invalid ${role} message`)
  }
  if (typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new ChatGPTPlanHistoryInputError(`Invalid ${role} message content`)
  }
  const images = value.images === undefined ? [] : value.images
  if (!Array.isArray(images) || images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ChatGPTPlanHistoryInputError(`Invalid ${role} message images`)
  }
  for (const image of images) {
    if (!isValidImage(image)) throw new ChatGPTPlanHistoryInputError(`Invalid ${role} message images`)
  }
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : ''
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new ChatGPTPlanHistoryInputError(`Invalid ${role} message timestamp`)
  }
  return { id: value.id, role, content: value.content, images: images as string[], createdAt }
}

type ConversationMetadata = Pick<ChatGPTPlanHistoryTurnInput,
  'conversationId' | 'createConversation' | 'title' | 'projectId'>

function validateConversationMetadata(value: Record<string, unknown>): ConversationMetadata {
  if (!isUUID(value.conversationId)) {
    throw new ChatGPTPlanHistoryInputError('Invalid ChatGPT plan conversation metadata')
  }
  if (typeof value.createConversation !== 'boolean') {
    throw new ChatGPTPlanHistoryInputError('Invalid ChatGPT plan conversation metadata')
  }
  if (typeof value.title !== 'string' || value.title.trim().length < 1 || value.title.length > 200) {
    throw new ChatGPTPlanHistoryInputError('Invalid ChatGPT plan conversation metadata')
  }
  if (value.projectId !== null && !isUUID(value.projectId)) {
    throw new ChatGPTPlanHistoryInputError('Invalid ChatGPT plan conversation metadata')
  }
  return {
    conversationId: value.conversationId,
    createConversation: value.createConversation,
    title: value.title.trim(),
    projectId: value.projectId,
  }
}

function validateRegeneration(value: unknown): ChatGPTPlanHistoryTurnInput['regeneration'] {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || !hasOnlyKeys(value, ALLOWED_REGENERATION_KEYS)) {
    throw new ChatGPTPlanHistoryInputError('Invalid regeneration identity')
  }
  if (value.operation !== 'replace-assistant' && value.operation !== 'replace-from-user') {
    throw new ChatGPTPlanHistoryInputError('Invalid regeneration identity')
  }
  if (!isUUID(value.expectedTailMessageID)) {
    throw new ChatGPTPlanHistoryInputError('Invalid regeneration identity')
  }
  const target = value.targetAssistantMessageID
  if (target !== null && !isUUID(target)) {
    throw new ChatGPTPlanHistoryInputError('Invalid regeneration target')
  }
  if (value.operation === 'replace-assistant'
      && (target === null || target !== value.expectedTailMessageID)) {
    throw new ChatGPTPlanHistoryInputError('Invalid regeneration target')
  }
  if (value.operation === 'replace-from-user' && target !== null) {
    throw new ChatGPTPlanHistoryInputError('Invalid regeneration target')
  }
  return {
    operation: value.operation,
    expectedTailMessageID: value.expectedTailMessageID,
    targetAssistantMessageID: target,
  }
}

export function validateChatGPTPlanHistoryTurn(value: unknown): ChatGPTPlanHistoryTurnInput {
  if (!isRecord(value) || !hasOnlyKeys(value, ALLOWED_KEYS)) {
    throw new ChatGPTPlanHistoryInputError('Invalid ChatGPT plan history payload')
  }
  const metadata = validateConversationMetadata(value)
  const userMessage = validateMessage(value.userMessage, 'user')
  const assistantMessage = validateMessage(value.assistantMessage, 'assistant')
  if (userMessage.id === assistantMessage.id) throw new ChatGPTPlanHistoryInputError('Message IDs must be different')
  const regeneration = validateRegeneration(value.regeneration)
  return {
    ...metadata,
    userMessage,
    assistantMessage,
    regeneration,
  }
}

export type ChatGPTPlanHistoryPersistResult =
  | { kind: 'persisted' }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'unavailable'; code?: string }

type ExistingMessage = {
  id: string
  user_id: string
  conversation_id: string
  role: string
  content: string
  images: Json | null
  created_at: string
  seq: number
}

async function findExistingMessage(
  admin: SupabaseClient,
  messageId: string,
): Promise<ExistingMessage | null | { error: true }> {
  const result = await admin.from('messages')
    .select('id,user_id,conversation_id,role,content,images,created_at,seq')
    .eq('id', messageId)
    .maybeSingle()
  if (result.error) return { error: true }
  return result.data as ExistingMessage | null
}

function matchesMessage(existing: ExistingMessage, userId: string, conversationId: string,
                       message: ChatGPTPlanHistoryMessageInput): boolean {
  const expectedImages = message.images.length ? { refs: message.images } : null
  return existing.user_id === userId && existing.conversation_id === conversationId
    && existing.role === message.role && existing.content === message.content
    && JSON.stringify(existing.images ?? null) === JSON.stringify(expectedImages)
    && Date.parse(existing.created_at) === Date.parse(message.createdAt)
}

async function insertIdempotently(
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  message: ChatGPTPlanHistoryMessageInput,
): Promise<'inserted' | 'existing' | 'conflict' | 'unavailable'> {
  const row = {
    id: message.id,
    user_id: userId,
    conversation_id: conversationId,
    role: message.role,
    content: message.content,
    images: message.images.length ? { refs: message.images as unknown as Json[] } as Json : null,
    thinking: null,
    created_at: message.createdAt,
    seq: 1,
    status: 'terminal',
    identity_locked: true,
    content_hash: '00000000000000000000000000000000',
  }
  const inserted = await admin.from('messages').insert(row)
  if (!inserted.error) return 'inserted'
  if (inserted.error.code !== '23505') return 'unavailable'

  const existing = await findExistingMessage(admin, message.id)
  if (existing && !('error' in existing)
      && matchesMessage(existing, userId, conversationId, message)) return 'existing'
  if (existing && 'error' in existing) return 'unavailable'
  return 'conflict'
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
  if (target && 'error' in target) return { kind: 'unavailable' }
  if (!target) return { kind: 'ready' }
  if (target.user_id !== userId || target.conversation_id !== conversationId || target.role !== 'assistant') {
    return { kind: 'conflict' }
  }
  const deleted = await admin.from('messages').delete().eq('id', assistantId)
    .eq('conversation_id', conversationId).eq('user_id', userId)
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

type RegenerationStepResult = { kind: 'ready' } | Exclude<ChatGPTPlanHistoryPersistResult, { kind: 'persisted' }>
type RegenerationPreparation = RegenerationStepResult | { kind: 'already_saved' }

async function prepareRegeneration(
  admin: SupabaseClient,
  userId: string,
  input: ChatGPTPlanHistoryTurnInput,
): Promise<RegenerationPreparation> {
  const regeneration = input.regeneration
  if (!regeneration) return { kind: 'ready' }

  const alreadySaved = await findExistingMessage(admin, input.assistantMessage.id)
  if (alreadySaved && 'error' in alreadySaved) return { kind: 'unavailable' }
  if (alreadySaved) {
    return matchesMessage(alreadySaved, userId, input.conversationId, input.assistantMessage)
      ? { kind: 'already_saved' }
      : { kind: 'conflict' }
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

function mapMessageInsertFailure(result: 'inserted' | 'existing' | 'conflict' | 'unavailable'):
  ChatGPTPlanHistoryPersistResult | null {
  if (result === 'unavailable') return { kind: 'unavailable' }
  if (result === 'conflict') return { kind: 'conflict' }
  return null
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

  const userResult = await insertIdempotently(admin, userId, input.conversationId, input.userMessage)
  const userFailure = mapMessageInsertFailure(userResult)
  if (userFailure) return userFailure

  const regeneration = await prepareRegeneration(admin, userId, input)
  if (regeneration.kind !== 'ready' && regeneration.kind !== 'already_saved') return regeneration
  if (regeneration.kind === 'already_saved') return touchConversation(admin, userId, input.conversationId)

  const assistantResult = await insertIdempotently(admin, userId, input.conversationId, input.assistantMessage)
  const assistantFailure = mapMessageInsertFailure(assistantResult)
  if (assistantFailure) return assistantFailure
  return touchConversation(admin, userId, input.conversationId)
}
