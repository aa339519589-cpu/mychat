import type { SupabaseClient } from "@supabase/supabase-js"
import { articleWordCount, localDateParts, type DailyArticle } from "@/lib/article-data"
import { chatCompletionsUrl } from "@/lib/llm/openai"
import { runTurn } from "@/lib/llm/turn"

type DraftArticle = Pick<DailyArticle, "category" | "title" | "dek" | "body" | "readMinutes" | "coverVariant">

const EDITORIAL_PROMPT = `You are the editor of a thoughtful daily magazine. Create exactly three distinct, personalized articles in English.

Use the interest signals only as quiet editorial direction. Never quote, mention, summarize, or imply access to private conversations. Build original, useful essays that extend the reader's interests with fresh framing, concrete ideas, and elegant prose.

Requirements for every article:
- English only
- 500 to 1200 English words in the body
- A concise category, compelling title, one-sentence dek, and 5-9 minute read time
- 6 to 10 short paragraphs separated by two newline characters
- No markdown headings, bullets, chat language, AI references, or calls to talk with an assistant
- Vary the subject and tone across technology, craft, learning, work, culture, wellbeing, or ideas as the signals support

Return only a valid JSON array. Each object must have exactly these keys: category, title, dek, body, readMinutes, coverVariant. coverVariant must be a unique integer from 1 to 5.`

function cleanJson(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
}

function parseDrafts(value: string): DraftArticle[] {
  const parsed = JSON.parse(cleanJson(value))
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error("The article model did not return three stories")
  const seen = new Set<number>()
  return parsed.map((item: Record<string, unknown>) => {
    const body = typeof item.body === "string" ? item.body.trim() : ""
    const words = articleWordCount(body)
    const coverVariant = Number(item.coverVariant)
    const prose = [item.category, item.title, item.dek, body].filter(part => typeof part === "string").join(" ")
    if (
      typeof item.category !== "string" || !item.category.trim() ||
      typeof item.title !== "string" || !item.title.trim() ||
      typeof item.dek !== "string" || !item.dek.trim() ||
      words < 500 || words > 1200 ||
      !Number.isInteger(coverVariant) || coverVariant < 1 || coverVariant > 5 || seen.has(coverVariant) ||
      /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(prose)
    ) throw new Error("The article model returned an invalid story")
    seen.add(coverVariant)
    return {
      category: item.category.trim(),
      title: item.title.trim(),
      dek: item.dek.trim(),
      body,
      readMinutes: Math.min(9, Math.max(5, Number(item.readMinutes) || Math.round(words / 220))),
      coverVariant,
    }
  })
}

async function interestSignals(supabase: SupabaseClient, userId: string) {
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString()
  const [messages, conversations, projects] = await Promise.all([
    supabase.from("messages").select("content, created_at").eq("user_id", userId).eq("role", "user").gte("created_at", since).order("created_at", { ascending: false }).limit(60),
    supabase.from("conversations").select("title, updated_at").eq("user_id", userId).gte("updated_at", since).order("updated_at", { ascending: false }).limit(25),
    supabase.from("projects").select("name, instructions, updated_at").eq("user_id", userId).order("updated_at", { ascending: false }).limit(12),
  ])
  const messageText = (messages.data ?? []).map(row => String(row.content ?? "").slice(0, 900)).filter(Boolean)
  const titles = (conversations.data ?? []).map(row => String(row.title ?? "")).filter(Boolean)
  const projectText = (projects.data ?? []).map(row => `${row.name}: ${String(row.instructions ?? "").slice(0, 500)}`)
  return { messageText, titles, projectText }
}

export async function generateDailyBrief(supabase: SupabaseClient, userId: string, briefDate = localDateParts().date) {
  const existing = await supabase.from("articles").select("id").eq("user_id", userId).eq("brief_date", briefDate).limit(1)
  if (existing.data?.length) return

  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured")
  const signals = await interestSignals(supabase, userId)
  const context = [
    `Editorial date: ${briefDate}`,
    `Recent conversation themes: ${signals.titles.join(" | ") || "general curiosity and practical learning"}`,
    `Current projects: ${signals.projectText.join(" | ") || "none named"}`,
    `Recent questions and interests:\n${signals.messageText.join("\n---\n") || "No recent signals. Create a balanced brief for a curious general reader."}`,
  ].join("\n\n")
  const result = await runTurn(
    chatCompletionsUrl("https://api.deepseek.com"), apiKey, "deepseek-v4-flash",
    [{ role: "system", content: EDITORIAL_PROMPT }, { role: "user", content: context }], [], () => undefined,
    { adapter: "deepseek-openai", thinking: false, deferTextUntilTurnEnd: true, emitErrors: false, timeoutMs: 180_000 },
  )
  if (result.failed) throw new Error(result.error || "Article generation failed")
  const drafts = parseDrafts(result.content)
  const rows = drafts.map((draft, index) => ({
    user_id: userId,
    brief_date: briefDate,
    position: index + 1,
    category: draft.category,
    title: draft.title,
    dek: draft.dek,
    body: draft.body,
    read_minutes: draft.readMinutes,
    cover_variant: draft.coverVariant,
  }))
  const { error } = await supabase.from("articles").upsert(rows, { onConflict: "user_id,brief_date,position", ignoreDuplicates: true })
  if (error) throw error
}
