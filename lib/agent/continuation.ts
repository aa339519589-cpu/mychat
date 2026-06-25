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

const SELF_SERVICE_WORK = /(继续|安装(依赖)?|构建|编译|测试|验证|检查|排查|修复|重试|发布|上线|部署)/i
const REAL_USER_BLOCKER = /(登录|重新授权|授权失效|没有权限|缺少权限|api\s*key|密钥|密码|验证码|账号|付费|购买|请选择|需要你决定|需求冲突|缺少必要信息)/i
const SELF_TALK_MARKER = /(让我|我来|我先|我需要|我想|等等|好的|现在|实际上|看起来)/g
const SELF_TALK_ACTION = /(检查|看看|分析|修改|确认|读取|验证|搜索|试试|继续|部署|发布|修复)/g
const PREAMBLE_MARKER = /^(好(的)?[，,、 ]*)?(那我|我)(来|先|会|这就|马上|直接)?/i
const PREAMBLE_ACTION = /(做这件事|处理(这个问题|一下)?|开始|继续|先做|先看|先检查|检查一下|看看|处理一下|开始处理|直接开始|着手处理|来做|来处理|来开始|帮你处理)/i
const USER_FACING_CUE = /(确认发布|任务完成|已完成|Pull Request|PR|网页已经|网页成功|需要用户处理|变更文件|下一步：用户)/i

export function isCodeUserBlocker(question: string, reason: string): boolean {
  const text = `${question}\n${reason}`.trim()
  if (!text || SELF_SERVICE_WORK.test(text)) return false
  return REAL_USER_BLOCKER.test(text)
}

export function looksLikeCodeSelfTalk(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length < 24 || USER_FACING_CUE.test(normalized)) return false
  const markers = normalized.match(SELF_TALK_MARKER) ?? []
  const actions = normalized.match(SELF_TALK_ACTION) ?? []
  return markers.length >= 3 && actions.length >= 2
}

export function looksLikeCodePreamble(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized || normalized.length > 28 || USER_FACING_CUE.test(normalized)) return false
  return PREAMBLE_MARKER.test(normalized) && PREAMBLE_ACTION.test(normalized)
}

export function codeContinuationPrompt(state: CodeContinuationState): string | null {
  if (state.completed || state.waitingForUser) return null
  if (state.workspace) {
    if (state.published) return null
    if (state.hasChanges) {
      return "Workspace 仍有未发布改动，任务尚未完成。继续自主检查、测试和修复；完成后必须调用 publish。不要输出过程思考、自言自语或“让我…”式说明，直接调用工具。"
    }
    return state.usedTools
      ? "重新核对原始目标和刚才的工具结果。仍有工作就继续调用工具；确认任务已经完整完成后必须调用 complete。不要输出过程思考、自言自语或“让我…”式说明。"
      : "这是 Code Agent 任务。需要仓库操作就立即使用工具并持续执行；确认无需操作且任务已经完成时调用 complete。不要输出过程思考、自言自语或“让我…”式说明。"
  }

  if (!state.plannedRepo || state.plannedFiles === 0) {
    return "新项目尚未形成可执行的完整计划。继续调用工具，至少创建仓库并写入项目文件；不要输出过程思考、自言自语或“让我…”式说明。"
  }
  return null
}
