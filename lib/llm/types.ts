// 聊天后端内部用的"线上格式"类型

// 前端传来的一条原始消息。图片引用与理解摘要分层保存，按当前模型能力打包。
export type RawMsg = {
  id?: string
  role: string
  content: unknown
  images?: string[]
  imageSummary?: string
  ts?: string
}

// 前端传来的一个附件。
// - 文本 / 有文字层的 PDF：text 直接带文字
// - 扫描件 PDF：前端把每页渲染成图片放进 pageImages，后端用小米 Omni OCR 成文字
export type Attachment = { name: string; dataUrl: string; isPdf: boolean; text?: string; pageImages?: string[] }
