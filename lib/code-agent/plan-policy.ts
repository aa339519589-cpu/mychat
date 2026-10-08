/** Deny unknown tools as well as writes: descriptions and model prompts are not a boundary. */
const PLAN_TOOLS = new Set(['list_files', 'read_file', 'search', 'fetch_url', 'complete', 'ask_user'])

export function codePlanToolAllowed(name: string): boolean {
  return PLAN_TOOLS.has(name)
}

export async function executeCodePlanTool(
  name: string,
  execute: () => Promise<string>,
  complete: () => void,
): Promise<string> {
  if (!codePlanToolAllowed(name)) return 'Plan 模式已阻止此工具：仅允许读取和规划，不能写入、执行、安装或发布。'
  if (name === 'complete') {
    complete()
    return '只读计划已完成。没有修改文件、执行命令或发布。切换 Code 模式后可实施。'
  }
  return execute()
}
