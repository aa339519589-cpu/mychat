import type { CodeToolExecutorOptions, ToolEvent } from './definitions'

export type ToolParams = Readonly<Record<string, unknown>>
export type ToolHandler = (params: ToolParams) => string | Promise<string>
export type ToolHandlers = Readonly<Record<string, ToolHandler>>

export type CodeToolContext = Omit<CodeToolExecutorOptions, 'emit'> & {
  emit: (event: ToolEvent) => void
}
