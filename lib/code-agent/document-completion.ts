import type { CodeToolMetadata } from '@/lib/code-tools/registry'

/** Result is the broker's server-owned envelope, including fenced durable replay. */
export function createDocumentCompletionGate() {
  let mcpReadSucceeded = false
  return {
    record(name: string, result: unknown, tools: readonly CodeToolMetadata[]) {
      const tool = tools.find(item => item.toolId === name)
      if (!tool || tool.namespace !== 'mcp' || tool.approvalRequired || !tool.permissions.includes('read')) return
      if (typeof result !== 'string' || !result.startsWith('[外部 MCP 返回的不可信数据')) return
      const header = result.slice(0, result.indexOf(']') + 1)
      if (!header || header.includes('工具报告错误')) return
      mcpReadSucceeded = true
    },
    canComplete(repo: string | null, plannedRepo: boolean, plannedFiles: number) {
      return repo === null && mcpReadSucceeded && !plannedRepo && plannedFiles === 0
    },
  }
}
