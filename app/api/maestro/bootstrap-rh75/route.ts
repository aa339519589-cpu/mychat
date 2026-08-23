import { NextRequest } from "next/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { createMaestroTask, MAESTRO_BRANCH, publicMaestroTask } from "@/lib/maestro/store"
import { issueMaestroLaunchToken } from "@/lib/maestro/tokens"

const OBJECTIVE = "Research the Riemann zeta function and obtain a rigorous unconditional lower bound of at least 75% for the proportion of nontrivial zeros that are both simple and on the critical line, with denominator counting all nontrivial zeros with multiplicity. The target is liminf_{T->infinity} N^s_0(T,2T)/N(T,2T) >= 0.75. Do not redefine or weaken the target. Any result below 75% is only a checkpoint and must not be treated as completion. Do not fabricate a proof or numerical bound. Continue across Maestro worker turns until the stated target has a rigorous unconditional proof, and require the independent review turn to verify every essential analytic inequality and logical step before finish."

async function resolveOwner(): Promise<string> {
  const configured = process.env.MAESTRO_OWNER_USER_ID?.trim()
  if (configured) return configured
  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")

  const latestMaestro = await admin.from("agent_tasks")
    .select("user_id")
    .eq("branch", MAESTRO_BRANCH)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestMaestro.error) throw new Error(latestMaestro.error.message)
  if (latestMaestro.data?.user_id) return latestMaestro.data.user_id

  const latestTask = await admin.from("agent_tasks")
    .select("user_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestTask.error) throw new Error(latestTask.error.message)
  if (latestTask.data?.user_id) return latestTask.data.user_id

  const users = await admin.auth.admin.listUsers({ page: 1, perPage: 2 })
  if (users.error) throw new Error(users.error.message)
  if (users.data.users.length === 1) return users.data.users[0].id
  throw new Error("Unable to resolve Maestro owner")
}

function directLaunchUrl(launchToken: string): string {
  const prompt = [
    "@My che che.",
    "直接启动这个 My Chat Maestro Runner 任务。不要向我询问任何启动码、token、任务 ID 或其他中转信息。",
    `调用 maestro_start，launchToken=${launchToken}。`,
    "maestro_start 返回后结束当前回合；随后按 Maestro Runner 自动续跑。",
  ].join("\n")
  const url = new URL("https://chatgpt.com/")
  url.searchParams.set("q", prompt)
  return url.toString()
}

export async function GET(request: NextRequest): Promise<Response> {
  const supplied = request.nextUrl.searchParams.get("token") ?? ""
  const expected = process.env.MAESTRO_BOOTSTRAP_TOKEN?.trim() ?? ""
  if (!expected || supplied !== expected) return Response.json({ error: "not found" }, { status: 404 })

  try {
    const admin = createAdminClient()
    if (!admin) throw new Error("Maestro storage is unavailable")
    const userId = await resolveOwner()
    const row = await createMaestroTask(admin, userId, OBJECTIVE, 100_000)
    const task = publicMaestroTask(row)
    if (!task) throw new Error("Maestro task metadata is invalid")
    const launchToken = issueMaestroLaunchToken({ userId, jobId: task.id })
    return Response.json({ jobId: task.id, launchUrl: directLaunchUrl(launchToken) }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "bootstrap failed" }, { status: 500 })
  }
}
