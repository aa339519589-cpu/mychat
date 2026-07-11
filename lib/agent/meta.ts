import type { SupabaseClient } from "@supabase/supabase-js"
import { log } from "@/lib/logger"

export async function mergeTaskMeta(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  patch: Record<string, unknown>,
  removeKeys: string[] = [],
): Promise<Record<string, unknown> | null> {
  let rpcData: unknown = null
  let rpcError: { code?: string } | null = null
  try {
    const result = await supabase.rpc("merge_agent_task_meta", {
      input_task_id: taskId,
      patch,
      remove_keys: removeKeys,
    })
    rpcData = result.data
    rpcError = result.error
  } catch {
    rpcError = { code: "RPC_UNAVAILABLE" }
  }
  if (!rpcError && rpcData && typeof rpcData === "object") return rpcData as Record<string, unknown>

  // Compatibility path for deployments that have not applied the migration yet.
  log.warn("agentMeta", "Atomic meta merge unavailable; using compatibility fallback", { taskId, code: rpcError?.code })
  const { data: task, error: readError } = await supabase.from("agent_tasks")
    .select("meta").eq("id", taskId).eq("user_id", userId).single()
  if (readError || !task) return null
  const next = { ...((task.meta ?? {}) as Record<string, unknown>), ...patch }
  for (const key of removeKeys) delete next[key]
  const { error: updateError } = await supabase.from("agent_tasks")
    .update({ meta: next, updated_at: new Date().toISOString() })
    .eq("id", taskId).eq("user_id", userId)
  return updateError ? null : next
}
