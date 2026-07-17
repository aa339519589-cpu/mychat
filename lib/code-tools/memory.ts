import type { SupabaseClient } from "@/lib/supabase/types"
import { isRecord } from "@/lib/unknown-value"
import type { ToolEvent } from "./definitions"

function bigrams(value: string) {
  const result = new Set<string>()
  for (let index = 0; index < value.length - 1; index++) result.add(value.slice(index, index + 2))
  return result
}

function similarity(left: string, right: string) {
  const leftSet = bigrams(left)
  const rightSet = bigrams(right)
  const union = new Set([...leftSet, ...rightSet])
  if (union.size === 0) return 0
  let intersection = 0
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection++
  }
  return intersection / union.size
}

export async function rememberCodeMemory(options: {
  content: string
  repo?: string | null
  userId?: string | null
  supabase?: SupabaseClient | null
  emit: (event: ToolEvent) => void
}) {
  const { content, repo, userId, supabase, emit } = options
  if (!content || !repo) return content ? "尚未选择仓库，无法记忆。" : "内容为空。"

  let saved = false
  if (userId && supabase) {
    try {
      const { data: rawExisting } = await supabase
        .from("code_memories")
        .select("id, content")
        .eq("user_id", userId)
        .eq("repo", repo)
      const existing = Array.isArray(rawExisting) ? rawExisting.filter(isRecord) : []
      const duplicate = existing.find(row => (
        typeof row.id === "string"
        && typeof row.content === "string"
        && similarity(content, row.content) > 0.55
      ))

      if (duplicate && typeof duplicate.id === "string" && typeof duplicate.content === "string") {
        const { error } = await supabase
          .from("code_memories")
          .update({ content })
          .eq("id", duplicate.id)
          .eq("user_id", userId)
          .eq("repo", repo)
        emit({ step: { kind: "memory", label: `更新：${content.slice(0, 40)}` } })
        return error ? "记忆更新失败。" : `已更新已有记忆（旧内容: ${duplicate.content}）。`
      }

      const { error } = await supabase.from("code_memories").insert({ user_id: userId, repo, content })
      saved = !error
    } catch {
      saved = false
    }
  }
  emit({ step: { kind: "memory", label: `记住：${content.slice(0, 40)}` } })
  return saved ? "已记住。" : "记忆保存失败（可能未建表）。"
}
