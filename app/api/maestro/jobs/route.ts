import { resolveAuth } from "@/lib/api/guard"
import { clientMaestroTask, listMaestroTasks, type MaestroClientTask } from "@/lib/maestro/store"

export async function GET(request: Request): Promise<Response> {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  try {
    const rows = await listMaestroTasks(auth.supabase, auth.userId)
    return Response.json({ tasks: rows.map(clientMaestroTask).filter((task): task is MaestroClientTask => task !== null) })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Maestro 任务读取失败" }, { status: 500 })
  }
}

export async function POST(): Promise<Response> {
  return Response.json({
    error: "新 Maestro 任务请直接在 ChatGPT 中 @My che che. 并发送任务内容；内部任务凭证不再由用户复制或管理。",
  }, { status: 405, headers: { allow: "GET" } })
}
