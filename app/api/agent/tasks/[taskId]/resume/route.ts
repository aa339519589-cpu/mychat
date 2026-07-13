// POST /api/agent/tasks/[taskId]/resume — 恢复 failed/cancelled/waiting_for_user 任务
import { NextRequest } from "next/server"
import { json } from "@/lib/api/response"

export async function POST(_req: NextRequest, _context: { params: Promise<{ taskId: string }> }) {
  return json({
    error: "旧 resume 端点已停用；请发送新消息，由控制面原子创建续跑 Job。",
  }, 410)
}
