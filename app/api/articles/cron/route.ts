import { createClient } from "@supabase/supabase-js"
import { localDateParts } from "@/lib/article-data"
import { generateDailyBrief } from "@/lib/articles/generate"

export const maxDuration = 300

export async function GET(request: Request) {
  const secret = process.env.ARTICLES_CRON_SECRET
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 })
  const local = localDateParts()
  if (local.hour !== 6 && new URL(request.url).searchParams.get("force") !== "1") return Response.json({ skipped: true, localHour: local.hour })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return Response.json({ error: "Supabase service credentials are not configured" }, { status: 503 })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  let page = 1
  let generated = 0
  const failures: string[] = []
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 })
    if (error) return Response.json({ error: error.message }, { status: 500 })
    for (const user of data.users) {
      if (user.is_anonymous) continue
      try { await generateDailyBrief(admin, user.id, local.date); generated++ }
      catch (error) { failures.push(`${user.id}: ${error instanceof Error ? error.message : "failed"}`) }
    }
    if (data.users.length < 100) break
    page++
  }
  return Response.json({ date: local.date, generated, failures })
}
