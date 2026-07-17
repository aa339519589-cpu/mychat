import { isRecord } from '@/lib/unknown-value'
import { createFileToolHandlers } from './file-handlers'
import { createWorkflowToolHandlers } from './workflow-handlers'
import type { CodeToolExecutorOptions } from './definitions'
import type { CodeToolContext } from './executor-types'

export { buildCodeTools } from './definitions'

const PRIVATE_REPOSITORY_EXTERNAL_TOOLS = new Set(['search', 'fetch_url'])

export function createCodeToolExecutor(options: CodeToolExecutorOptions) {
  const context: CodeToolContext = {
    ...options,
    emit: event => options.emit(event),
  }
  const handlers = {
    ...createFileToolHandlers(context),
    ...createWorkflowToolHandlers(context),
  }

  return async function executeTool(name: string, input: unknown): Promise<string> {
    const params = isRecord(input) ? input : {}
    if (name !== 'complete') context.state.markUsedTool()
    if (context.repoIsPrivate && PRIVATE_REPOSITORY_EXTERNAL_TOOLS.has(name)) {
      return '安全策略已阻断：私有仓库任务不能把模型生成的查询或网址发送给外部检索服务。'
    }
    const handler = handlers[name]
    return handler ? handler(params) : '未知工具。'
  }
}
