// 聊天后端内部用的"线上格式"类型

// 前端传来的一条原始消息
export type RawMsg = { role: string; content: string; images?: string[]; ts?: string }

// 前端传来的一个附件；扫描件 PDF 经后端上传 DeepSeek Files API 后会填入 fileId
export type Attachment = { name: string; dataUrl: string; isPdf: boolean; text?: string; fileId?: string }
