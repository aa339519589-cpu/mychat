import { json } from '@/lib/api/response'

export function legacyWorkspaceMutationDisabled(): Response {
  return json({
    error: '该 HTTP workspace 操作已停用；所有长任务和文件副作用必须由耐久 Agent Job 在隔离 Worker 中执行。',
  }, 410)
}

export function localWorkspaceReadDisabled(): Response {
  return json({
    error: 'Web 服务没有权威 workspace 本地盘；请读取 DB current-head/CAS 遥测。',
  }, 410)
}
