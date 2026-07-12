import { resolveAuth } from "@/lib/api/guard"
import { localDateParts } from "@/lib/article-data"
import { generateDailyBrief } from "@/lib/articles/generate"

export const maxDuration = 300

export async function GET() {
  const { supabase, userId } = await resolveAuth()
  if (!supabase || !userId) return Response.json({ error: "Authentication required" }, { status: 401 })
  const date = localDateParts().date
  let result = await supabase.from("articles").select("id, brief_date, position, category, title, dek, body, read_minutes, cover_variant, cover_image_url, created_at").eq("user_id", userId).eq("brief_date", date).order("position")
  if (result.error) return Response.json({ error: "Articles are not available until the database migration is applied." }, { status: 503 })
  if (!result.data?.length) {
    try {
      await generateDailyBrief(supabase, userId, date)
      result = await supabase.from("articles").select("id, brief_date, position, category, title, dek, body, read_minutes, cover_variant, cover_image_url, created_at").eq("user_id", userId).eq("brief_date", date).order("position")
    } catch {
      return Response.json({ error: "Today's brief is still being prepared. Please try again shortly." }, { status: 503 })
    }
  }
  return Response.json({
    date,
    articles: (result.data ?? []).map(row => ({
      id: row.id, briefDate: row.brief_date, position: row.position, category: row.category,
      title: row.title, dek: row.dek, body: row.body, readMinutes: row.read_minutes,
      coverVariant: row.cover_variant, coverImageUrl: row.cover_image_url, createdAt: row.created_at,
    })),
  }, { headers: { "Cache-Control": "private, no-store" } })
}
