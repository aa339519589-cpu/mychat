import type { GeneratedMedia } from "@/lib/generated-media"

// SSE 事件契约：服务端 emit 与前端解析共用的唯一真源。
// 服务端每次只发一个单键事件对象；前端按键名分支处理。新增事件类型只改这里。

type MemoryEvent = {
  action: 'create' | 'update' | 'delete'
  id?: string
  content?: string
  ok: boolean
  timestamp?: string
}

type SearchEvent = {
  query: string
  results: { title: string; url: string }[]
}

// Code 板块：一步操作的进度提示（浏览/读取/写入/部署/记忆…）
type StepEvent = { kind: string; label: string }

type ImageSummaryEvent = { messageId: string; summary: string }

// Code 板块：加入「待执行计划」的动作，前端展示供用户确认
type CodePlan =
  | { kind: 'create_repo'; name: string; description: string; private: boolean }
  | { kind: 'write_file'; path: string; oldContent: string; newContent: string }
  | { kind: 'delete_file'; path: string }
  | { kind: 'enable_pages' }

// 流式过程中服务端能推给前端的全部事件
export type ChatEvent =
  | { text: string }
  | { thinking: string }
  | { error: string }
  | { memory: MemoryEvent }
  | { search: SearchEvent }
  | { imageSummary: ImageSummaryEvent }
  | { media: GeneratedMedia }
  | { step: StepEvent }
  | { plan: CodePlan }

// 把一个事件推给前端（由 route 用 SSE send 实现，注入到 turn / agent-loop）
export type Emit = (event: ChatEvent) => void
