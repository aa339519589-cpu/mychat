import type { SupabaseClient } from "@supabase/supabase-js"
import { log } from "@/lib/logger"

export async function mergeTaskMeta(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  patch: Record<string, unknown>,
  removeKeys: string[] = [],
): Promise<Record<string, unknown> | null> {
  try {
    const result = await supabase.rpc("merge_agent_task_meta", {
      input_task_id: taskId,
      patch,
      remove_keys: removeKeys,
    })
    if (!result.error && result.data && typeof result.data === "object") {
      return result.data as Record<string, unknown>
    }
    log.error("agentMeta", "Atomic meta merge failed", { taskId, userId, code: result.error?.code })
  } catch (error) {
    log.error("agentMeta", "Atomic meta merge unavailable", { taskId, userId, error })
  }
  return null
}
