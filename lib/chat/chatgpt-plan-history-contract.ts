export type ChatGPTPlanHistoryMessageInput = {
  id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string
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
const ALLOWED_MESSAGE_KEYS = new Set(['id', 'role', 'content', 'thinking', 'images', 'createdAt'])
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
  const thinking = value.thinking === null || value.thinking === undefined ? undefined : value.thinking
  if (role === 'user' && thinking !== undefined) {
    throw new ChatGPTPlanHistoryInputError('User message cannot contain thinking')
  }
  if (thinking !== undefined
      && (typeof thinking !== 'string' || Buffer.byteLength(thinking, 'utf8') > MAX_CONTENT_BYTES)) {
    throw new ChatGPTPlanHistoryInputError(`Invalid ${role} message thinking`)
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
  return {
    id: value.id,
    role,
    content: value.content,
    ...(typeof thinking === 'string' ? { thinking } : {}),
    images: images as string[],
    createdAt,
  }
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
  return { ...metadata, userMessage, assistantMessage, regeneration }
}

export type ChatGPTPlanHistoryPersistResult =
  | { kind: 'persisted' }
  | { kind: 'not_found' }
  | { kind: 'conflict' }
  | { kind: 'unavailable'; code?: string }
