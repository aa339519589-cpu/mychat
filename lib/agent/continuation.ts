export type CodeContinuationState = {
  workspace: boolean
  idleCount: number
  usedTools: boolean
  hasChanges: boolean
  published: boolean
  plannedRepo: boolean
  plannedFiles: number
}

export function codeContinuationPrompt(state: CodeContinuationState): string | null {
  if (state.workspace) {
    if (state.published) return null
    if (state.hasChanges) {
      return "Workspace 仍有未发布改动，任务尚未完成。继续自主检查、测试和修复；完成后必须调用 publish。不要等待用户说继续。"
    }
    if (state.idleCount === 0) {
      return state.usedTools
        ? "重新核对原始目标和刚才的工具结果。若仍有工作就继续调用工具；只有确认无需修改或已经完整回答时才给最终结论。不要重复上一段话。"
        : "这是 Code Agent 任务。若目标需要读取、修改或验证仓库，现在直接使用工具并持续执行；只有确认无需仓库操作时才给最终结论。不要等待用户说继续。"
    }
    return null
  }

  if (state.idleCount === 0 && (!state.plannedRepo || state.plannedFiles === 0)) {
    return "新项目尚未形成可执行的完整计划。继续调用工具，至少创建仓库并写入项目文件；不要等待用户说继续。"
  }
  return null
}
