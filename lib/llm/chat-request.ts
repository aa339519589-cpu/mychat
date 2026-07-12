import type { Memory } from "@/lib/memory-data"
import type { ProjectContext } from "@/lib/project-data"
import type { Attachment, RawMsg } from "./types"
import { RequestError } from "@/lib/api/request"

const MAX_MESSAGES = 500
const MAX_MESSAGE_CHARS = 100_000
const MAX_TOTAL_MESSAGE_CHARS = 2_000_000
const MAX_IMAGE_CHARS = 8_000_000
const MAX_TOTAL_IMAGE_CHARS = 32_000_000
const MAX_ATTACHMENT_TEXT_CHARS = 200_000
const MAX_TOTAL_ATTACHMENT_TEXT_CHARS = 600_000
const MAX_SCAN_PAGES = 18

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
  historyRetrieval?: boolean
  endpointId?: string
  /** Durable generation id (server continues after client disconnect). */
  generationId?: string
  /** Pre-created assistant message row to stream into. */
  assistantMessageId?: string
  /** Platform / deep-tier reverse-proxy image generation */
  generateImage?: boolean
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, part) => {
    const text = typeof part?.text === "string" ? part.text : ""
    return sum + text.length
  }, 0)
}

function validImageRef(value: unknown): value is string {
  return typeof value === "string" && /^(data:image\/(?:png|jpeg|jpg|webp|gif);base64,|https?:\/\/)/i.test(value)
}

export function validateChatRequest(value: unknown): ChatRequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "请求体格式错误")
  }
  const body = value as Record<string, any>
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestError(400, "messages 不能为空")
  }
  if (body.messages.length > MAX_MESSAGES) throw new RequestError(413, "消息数量过多")

  let totalMessageChars = 0
  let totalImageChars = 0
  for (const message of body.messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      throw new RequestError(400, "消息角色无效")
    }
    if (typeof message.content !== "string" && !Array.isArray(message.content)) {
      throw new RequestError(400, "消息内容格式无效")
    }
    if (Array.isArray(message.content)) {
      if (message.content.length > 20) throw new RequestError(400, "消息内容分段过多")
      for (const part of message.content) {
        if (!part || typeof part !== "object") throw new RequestError(400, "消息内容分段无效")
        if (part.type === "text" && typeof part.text === "string") continue
        if (part.type === "image_url" && validImageRef(part.image_url?.url)) {
          if (part.image_url.url.length > MAX_IMAGE_CHARS) throw new RequestError(413, "单张图片过大")
          totalImageChars += part.image_url.url.length
          continue
        }
        throw new RequestError(400, "消息内容包含不支持的分段")
      }
    }
    const length = textLength(message.content)
    if (length > MAX_MESSAGE_CHARS) throw new RequestError(413, "单条消息过长")
    totalMessageChars += length
    if (Array.isArray(message.images)) {
      if (message.images.length > 8 || !message.images.every(validImageRef)) {
        throw new RequestError(400, "消息图片格式无效")
      }
      for (const image of message.images) {
        if (image.length > MAX_IMAGE_CHARS) throw new RequestError(413, "单张图片过大")
        totalImageChars += image.length
      }
    }
    if (message.imageSummary !== undefined && (typeof message.imageSummary !== "string" || message.imageSummary.length > 20_000)) {
      throw new RequestError(400, "图片摘要格式无效")
    }
  }
  if (totalMessageChars > MAX_TOTAL_MESSAGE_CHARS) throw new RequestError(413, "消息上下文过大")

  const attachments = body.attachments
  let totalAttachmentText = 0
  let scanPages = 0
  if (attachments !== undefined) {
    if (!Array.isArray(attachments) || attachments.length > 8) throw new RequestError(400, "附件数量无效")
    for (const attachment of attachments) {
      if (!attachment || typeof attachment.name !== "string" || attachment.name.length > 255) {
        throw new RequestError(400, "附件名称无效")
      }
      if (attachment.text !== undefined && typeof attachment.text !== "string") {
        throw new RequestError(400, "附件文本格式无效")
      }
      const attachmentLength = attachment.text?.length ?? 0
      if (attachmentLength > MAX_ATTACHMENT_TEXT_CHARS) throw new RequestError(413, "单个附件文本过大")
      totalAttachmentText += attachmentLength
      if (attachment.pageImages !== undefined) {
        if (!Array.isArray(attachment.pageImages) || !attachment.pageImages.every(validImageRef)) {
          throw new RequestError(400, "扫描件图片格式无效")
        }
        scanPages += attachment.pageImages.length
        for (const image of attachment.pageImages) {
          if (image.length > MAX_IMAGE_CHARS) throw new RequestError(413, "扫描页图片过大")
          totalImageChars += image.length
        }
      }
    }
  }
  if (totalAttachmentText > MAX_TOTAL_ATTACHMENT_TEXT_CHARS) throw new RequestError(413, "附件文本总量过大")
  if (scanPages > MAX_SCAN_PAGES) throw new RequestError(413, `扫描件最多支持 ${MAX_SCAN_PAGES} 页`)
  if (totalImageChars > MAX_TOTAL_IMAGE_CHARS) throw new RequestError(413, "图片总量过大")

  if (body.memories !== undefined) {
    if (!Array.isArray(body.memories) || body.memories.length > 200) throw new RequestError(400, "记忆数据无效")
    if (body.memories.some((memory: any) => !memory || typeof memory.id !== "string" || typeof memory.content !== "string" || memory.content.length > 10_000 || (memory.timestamp !== undefined && typeof memory.timestamp !== "string"))) {
      throw new RequestError(400, "记忆内容无效")
    }
  }
  if (body.project !== undefined) {
    const project = body.project
    if (!project || typeof project.id !== "string" || project.id.length > 128) throw new RequestError(400, "项目数据无效")
    if (typeof project.instructions === "string" && project.instructions.length > 50_000) throw new RequestError(413, "项目指令过长")
    const files = Array.isArray(project.files) ? project.files : []
    if (files.some((file: any) => !file || typeof file.name !== "string" || file.name.length > 255 || typeof file.content !== "string" || file.content.length > 200_000)) {
      throw new RequestError(400, "项目资料格式无效")
    }
    if (files.length > 30 || files.reduce((sum: number, file: any) => sum + file.content.length, 0) > 800_000) {
      throw new RequestError(413, "项目资料过大")
    }
    const projectMemories = Array.isArray(project.projectMemories) ? project.projectMemories : []
    if (projectMemories.length > 200 || projectMemories.some((memory: any) => !memory || typeof memory.id !== "string" || typeof memory.content !== "string" || memory.content.length > 10_000)) {
      throw new RequestError(400, "项目记忆格式无效")
    }
  }

  if (body.conversationId !== undefined && (typeof body.conversationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.conversationId))) {
    throw new RequestError(400, "conversationId 无效")
  }
  if (body.endpointId !== undefined && (typeof body.endpointId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.endpointId))) {
    throw new RequestError(400, "endpointId 无效")
  }
  if (body.generationId !== undefined && (typeof body.generationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.generationId))) {
    throw new RequestError(400, "generationId 无效")
  }
  if (body.assistantMessageId !== undefined && (typeof body.assistantMessageId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.assistantMessageId))) {
    throw new RequestError(400, "assistantMessageId 无效")
  }
  if (body.generateImage !== undefined && typeof body.generateImage !== "boolean") {
    throw new RequestError(400, "generateImage 无效")
  }
  if (body.tier !== undefined && !["绝句", "正构", "鸿篇", "观照"].includes(body.tier)) throw new RequestError(400, "tier 无效")
  if (body.searchMode !== undefined && !["off", "web", "deep"].includes(body.searchMode)) throw new RequestError(400, "searchMode 无效")
  for (const field of ["deepResearch", "historyRetrieval"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") throw new RequestError(400, `${field} 无效`)
  }

  return body as ChatRequestBody
}
