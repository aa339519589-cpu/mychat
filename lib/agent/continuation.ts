export type CodeContinuationState = {
  workspace: boolean
  usedTools: boolean
  hasChanges: boolean
  published: boolean
  completed: boolean
  waitingForUser: boolean
  plannedRepo: boolean
  plannedFiles: number
}

export function codeContinuationPrompt(state: CodeContinuationState): string | null {
  if (state.completed || state.waitingForUser) return null
  if (state.workspace) {
    if (state.published) return null
    if (state.hasChanges) {
      return "Workspace 仍有未发布改动，任务尚未完成。继续自主检查、测试和修复；完成后必须调用 publish。不要等待用户说继续。"
    }
    return state.usedTools
      ? "重新核对原始目标和刚才的工具结果。仍有工作就继续调用工具；确认任务已经完整完成后必须调用 complete。不要停下来等待用户说继续。"
      : "这是 Code Agent 任务。需要仓库操作就立即使用工具并持续执行；确认无需操作且任务已经完成时调用 complete。不要停下来等待用户说继续。"
  }

  if (!state.plannedRepo || state.plannedFiles === 0) {
    return "新项目尚未形成可执行的完整计划。继续调用工具，至少创建仓库并写入项目文件；不要等待用户说继续。"
  }
  return null
}
