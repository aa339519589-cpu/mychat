// 工具注册表：所有工具登记在这里，route.ts 只跟这层打交道。
//
// ★ 新增一个工具：
//   1. 建 lib/tools/你的工具.ts，导出一个 ToolDef（参考 web-search.ts）
//   2. 在下面 ALL_TOOLS 里加一行
//   就这样——route.ts、协议层都不用动。
import { memoryTools } from './memory'
import { webSearchTool } from './web-search'
import { fetchUrlTool } from './fetch-url'
import type { ToolDef, ToolFlags, ToolContext, ToolOutcome } from './types'

export type { ToolDef, ToolFlags, ToolContext, ToolOutcome } from './types'

const ALL_TOOLS: ToolDef[] = [...memoryTools, webSearchTool, fetchUrlTool]

// 按本次请求的上下文（是否登录、是否开启联网）筛出可用工具
export function activeTools(flags: ToolFlags): ToolDef[] {
  return ALL_TOOLS.filter(t => t.enabled(flags))
}

// 转成 Anthropic 的工具格式
export function toAnthropicTools(tools: ToolDef[]) {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }))
}

// 转成 OpenAI / 兼容协议的工具格式
export function toOpenAITools(tools: ToolDef[]) {
  return tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }))
}

// 按名字派发执行；返回回灌模型的文字 + 可选的前端事件
export async function execTool(tools: ToolDef[], name: string, input: any, ctx: ToolContext): Promise<ToolOutcome> {
  const tool = tools.find(t => t.name === name)
  if (!tool) return { result: '未知工具' }
  return tool.execute(input, ctx)
}
