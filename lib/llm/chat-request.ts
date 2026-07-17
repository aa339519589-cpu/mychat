import type { Memory } from "@/lib/memory-data"
import type { ProjectContext } from "@/lib/project-data"
import type { Attachment, RawMsg } from "./types"
import { RequestError } from "@/lib/api/request"
import { isRecord } from '@/lib/unknown-value'

const MAX_MESSAGES = 500
const MAX_MESSAGE_CHARS = 100_000
const MAX_TOTAL_MESSAGE_CHARS = 2_000_000
const MAX_IMAGE_CHARS = 8_000_000
const MAX_TOTAL_IMAGE_CHARS = 32_000_000
const MAX_ATTACHMENT_TEXT_CHARS = 200_000
const MAX_TOTAL_ATTACHMENT_TEXT_CHARS = 600_000
const MAX_SCAN_PAGES = 18
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ChatRequestBody = {
  tier?: string
  messages: RawMsg[]
  memories?: Memory[]
  attachments?: Attachment[]
  searchMode?: unknown
  webSearch?: unknown
  deepWebSearch?: unknown
  deepResearch?: boolean
  project?: ProjectContext
  conversationId?: string
  /** Canonical user message that caused this generation. */
  userMessageId?: string
  historyRetrieval?: boolean
  endpointId?: string
  /** Durable generation id (server continues after client disconnect). */
  generationId?: string
  /** Pre-created assistant message row to stream into. */
  assistantMessageId?: string
  /** Platform / deep-tier reverse-proxy image generation */
  generateImage?: boolean
  generateVideo?: boolean
  /** Server-owned persistence contract for a complete user + assistant turn. */
  turn?: ChatTurnAuthority
}

export type ChatAppendAuthority = {
  schemaVersion: 1
  createConversation: boolean
  title: string
  projectId: string | null
}

export type ChatRegenerationAuthority = {
  schemaVersion: 2
  operation: 'replace-assistant' | 'replace-from-user'
  expectedTailMessageId: string
  targetAssistantMessageId?: string
}

export type ChatTurnAuthority = ChatAppendAuthority | ChatRegenerationAuthority

export type DurableChatRequestBody = ChatRequestBody & Required<Pick<
  ChatRequestBody,
  'conversationId' | 'userMessageId' | 'generationId' | 'assistantMessageId'
>>

function validImageRef(value: unknown): value is string {
  return typeof value === "string" && /^(data:image\/(?:png|jpeg|jpg|webp|gif);base64,|https?:\/\/)/i.test(value)
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

type PayloadMetrics = { textChars: number; imageChars: number; scanPages: number }

function validateContentPart(value: unknown): Pick<PayloadMetrics, 'textChars' | 'imageChars'> {
  if (!isRecord(value)) throw new RequestError(400, '消息内容分段无效')
  const textChars = typeof value.text === 'string' ? value.text.length : 0
  if (value.type === 'text' && typeof value.text === 'string') {
    return { textChars, imageChars: 0 }
  }
  const image = isRecord(value.image_url) ? value.image_url : null
  if (value.type !== 'image_url' || !validImageRef(image?.url)) {
    throw new RequestError(400, '消息内容包含不支持的分段')
  }
  if (image.url.length > MAX_IMAGE_CHARS) throw new RequestError(413, '单张图片过大')
  return { textChars, imageChars: image.url.length }
}

function validateMessageContent(content: unknown): Pick<PayloadMetrics, 'textChars' | 'imageChars'> {
  if (typeof content === 'string') {
    if (content.length > MAX_MESSAGE_CHARS) throw new RequestError(413, '单条消息过长')
    return { textChars: content.length, imageChars: 0 }
  }
  if (!Array.isArray(content)) throw new RequestError(400, '消息内容格式无效')
  if (content.length > 20) throw new RequestError(400, '消息内容分段过多')

  let textChars = 0
  let imageChars = 0
  for (const value of content) {
    const metrics = validateContentPart(value)
    textChars += metrics.textChars
    imageChars += metrics.imageChars
  }
  if (textChars > MAX_MESSAGE_CHARS) throw new RequestError(413, '单条消息过长')
  return { textChars, imageChars }
}

function validateMessageImages(value: unknown): number {
  if (value === undefined) return 0
  if (!Array.isArray(value) || value.length > 8 || !value.every(validImageRef)) {
    throw new RequestError(400, '消息图片格式无效')
  }
  let imageChars = 0
  for (const image of value) {
    if (image.length > MAX_IMAGE_CHARS) throw new RequestError(413, '单张图片过大')
    imageChars += image.length
  }
  return imageChars
}

function validateMessage(value: unknown): Pick<PayloadMetrics, 'textChars' | 'imageChars'> {
  if (!isRecord(value)) throw new RequestError(400, '消息格式无效')
  if (value.role !== 'user' && value.role !== 'assistant') {
    throw new RequestError(400, '消息角色无效')
  }
  if (value.ts !== undefined && (typeof value.ts !== 'string'
    || !Number.isFinite(Date.parse(value.ts)))) {
    throw new RequestError(400, '消息时间无效')
  }
  if (value.imageSummary !== undefined
    && (typeof value.imageSummary !== 'string' || value.imageSummary.length > 20_000)) {
    throw new RequestError(400, '图片摘要格式无效')
  }
  const content = validateMessageContent(value.content)
  return { ...content, imageChars: content.imageChars + validateMessageImages(value.images) }
}

function validateMessages(value: unknown): Pick<PayloadMetrics, 'textChars' | 'imageChars'> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new RequestError(400, 'messages 不能为空')
  }
  if (value.length > MAX_MESSAGES) throw new RequestError(413, '消息数量过多')
  const totals = value.reduce((result, message) => {
    const metrics = validateMessage(message)
    return {
      textChars: result.textChars + metrics.textChars,
      imageChars: result.imageChars + metrics.imageChars,
    }
  }, { textChars: 0, imageChars: 0 })
  if (totals.textChars > MAX_TOTAL_MESSAGE_CHARS) throw new RequestError(413, '消息上下文过大')
  return totals
}

function validateAttachment(value: unknown): PayloadMetrics {
  if (!isRecord(value)) throw new RequestError(400, '附件格式无效')
  if (typeof value.name !== 'string' || value.name.length > 255) {
    throw new RequestError(400, '附件名称无效')
  }
  if (typeof value.dataUrl !== 'string' || typeof value.isPdf !== 'boolean') {
    throw new RequestError(400, '附件格式无效')
  }
  if (value.text !== undefined && typeof value.text !== 'string') {
    throw new RequestError(400, '附件文本格式无效')
  }
  const textChars = typeof value.text === 'string' ? value.text.length : 0
  if (textChars > MAX_ATTACHMENT_TEXT_CHARS) throw new RequestError(413, '单个附件文本过大')
  if (value.pageImages === undefined) return { textChars, imageChars: 0, scanPages: 0 }
  if (!Array.isArray(value.pageImages) || !value.pageImages.every(validImageRef)) {
    throw new RequestError(400, '扫描件图片格式无效')
  }
  let imageChars = 0
  for (const image of value.pageImages) {
    if (image.length > MAX_IMAGE_CHARS) throw new RequestError(413, '扫描页图片过大')
    imageChars += image.length
  }
  return { textChars, imageChars, scanPages: value.pageImages.length }
}

function validateAttachments(value: unknown): PayloadMetrics {
  if (value === undefined) return { textChars: 0, imageChars: 0, scanPages: 0 }
  if (!Array.isArray(value) || value.length > 8) throw new RequestError(400, '附件数量无效')
  const totals = value.reduce((result, attachment) => {
    const metrics = validateAttachment(attachment)
    return {
      textChars: result.textChars + metrics.textChars,
      imageChars: result.imageChars + metrics.imageChars,
      scanPages: result.scanPages + metrics.scanPages,
    }
  }, { textChars: 0, imageChars: 0, scanPages: 0 })
  if (totals.textChars > MAX_TOTAL_ATTACHMENT_TEXT_CHARS) throw new RequestError(413, '附件文本总量过大')
  if (totals.scanPages > MAX_SCAN_PAGES) throw new RequestError(413, `扫描件最多支持 ${MAX_SCAN_PAGES} 页`)
  return totals
}

function validateMemories(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 200) throw new RequestError(400, '记忆数据无效')
  if (value.some(memory => !isRecord(memory)
    || typeof memory.id !== 'string'
    || typeof memory.content !== 'string'
    || memory.content.length > 10_000
    || (memory.timestamp !== undefined && typeof memory.timestamp !== 'string'))) {
    throw new RequestError(400, '记忆内容无效')
  }
}

function validateProject(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length > 128) {
    throw new RequestError(400, '项目数据无效')
  }
  if (typeof value.instructions !== 'string') throw new RequestError(400, '项目指令格式无效')
  if (value.instructions.length > 50_000) throw new RequestError(413, '项目指令过长')
  if (!Array.isArray(value.files)) throw new RequestError(400, '项目资料格式无效')
  if (value.files.some(file => !isRecord(file)
    || typeof file.name !== 'string'
    || file.name.length > 255
    || typeof file.content !== 'string'
    || file.content.length > 200_000)) {
    throw new RequestError(400, '项目资料格式无效')
  }
  const fileChars = value.files.reduce((sum, file) => sum
    + (isRecord(file) && typeof file.content === 'string' ? file.content.length : 0), 0)
  if (value.files.length > 30 || fileChars > 800_000) throw new RequestError(413, '项目资料过大')
  if (!Array.isArray(value.projectMemories)
    || value.projectMemories.length > 200
    || value.projectMemories.some(memory => !isRecord(memory)
      || typeof memory.id !== 'string'
      || typeof memory.content !== 'string'
      || memory.content.length > 10_000)) {
    throw new RequestError(400, '项目记忆格式无效')
  }
}

function validAppendTurn(turn: Record<string, unknown>): boolean {
  return turn.schemaVersion === 1
    && typeof turn.createConversation === 'boolean'
    && typeof turn.title === 'string'
    && turn.title.length >= 1
    && turn.title.length <= 200
    && (turn.projectId === null || validUuid(turn.projectId))
}

function validRegenerationTurn(turn: Record<string, unknown>): boolean {
  if (turn.schemaVersion !== 2 || !validUuid(turn.expectedTailMessageId)) return false
  if (turn.operation === 'replace-from-user') return turn.targetAssistantMessageId === undefined
  return turn.operation === 'replace-assistant'
    && validUuid(turn.targetAssistantMessageId)
    && turn.targetAssistantMessageId === turn.expectedTailMessageId
}

function validateTurn(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || (!validAppendTurn(value) && !validRegenerationTurn(value))) {
    throw new RequestError(400, 'turn 无效')
  }
}

function validateScalarFields(body: Record<string, unknown>): void {
  for (const field of [
    'conversationId', 'userMessageId', 'endpointId', 'generationId', 'assistantMessageId',
  ] as const) {
    if (body[field] !== undefined && !validUuid(body[field])) {
      throw new RequestError(400, `${field} 无效`)
    }
  }
  for (const field of ['generateImage', 'generateVideo', 'deepResearch', 'historyRetrieval'] as const) {
    if (body[field] !== undefined && typeof body[field] !== 'boolean') {
      throw new RequestError(400, `${field} 无效`)
    }
  }
  if (body.tier !== undefined
    && (typeof body.tier !== 'string' || !['绝句', '正构', '鸿篇', '观照', '绘影', '录像'].includes(body.tier))) {
    throw new RequestError(400, 'tier 无效')
  }
  if (body.searchMode !== undefined
    && (typeof body.searchMode !== 'string' || !['off', 'web', 'deep'].includes(body.searchMode))) {
    throw new RequestError(400, 'searchMode 无效')
  }
}

export function validateChatRequest(value: unknown): ChatRequestBody {
  if (!isRecord(value)) throw new RequestError(400, '请求体格式错误')
  const messageTotals = validateMessages(value.messages)
  const attachmentTotals = validateAttachments(value.attachments)
  if (messageTotals.imageChars + attachmentTotals.imageChars > MAX_TOTAL_IMAGE_CHARS) {
    throw new RequestError(413, '图片总量过大')
  }
  validateMemories(value.memories)
  validateProject(value.project)
  validateTurn(value.turn)
  validateScalarFields(value)
  return value as ChatRequestBody
}

// The general chat endpoint can execute tools and expensive media jobs, so every
// request must be tied to a stable, client-created durable identity. Small,
// side-effect-free jobs such as title generation use their own endpoint.
export function requireDurableChatIdentity(
  body: ChatRequestBody,
): asserts body is DurableChatRequestBody {
  if (!body.conversationId || !body.userMessageId || !body.generationId || !body.assistantMessageId) {
    throw new RequestError(
      400,
      'conversationId、userMessageId、generationId 和 assistantMessageId 必须同时提供',
    )
  }
}
