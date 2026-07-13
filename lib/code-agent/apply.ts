import type { SupabaseClient } from '@supabase/supabase-js'
import type { CodeApplyOutcome } from './apply-contract'
import type { CodeApplyRequest } from './apply-request'
import { requestOrEnqueueAgentOperation } from './operation-enqueue'
import { prepareAgentOperation } from './operation-plan'

/** Application service: DB-only validation, confirmation and atomic enqueue.
 * GitHub, filesystem and deployment work are intentionally absent here. */
export async function applyCodeChanges(input: {
  request: CodeApplyRequest
  client: SupabaseClient
  userId: string
  authClass: 'anonymous' | 'registered'
}): Promise<CodeApplyOutcome & { headers?: Record<string, string> }> {
  const { request, client, userId } = input
  if (!request.taskId) return { status: 400, body: { error: '缺少耐久发布 taskId' } }
  const prepared = await prepareAgentOperation(client, userId, request)
  return requestOrEnqueueAgentOperation({
    client,
    userId,
    authClass: input.authClass,
    prepared,
    confirmation: request.confirmation,
  })
}
