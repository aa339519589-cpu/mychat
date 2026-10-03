import { enforceRequestRateLimit, getSensitiveMemoryEnabled, resolveAuth } from '@/lib/api/guard'
import { classifyMemorySensitivity } from '@/lib/api/memory-sensitivity'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { parseMemoryImportInput, type MemoryInput } from '@/lib/api/memory-input'
import type { SupabaseClient } from '@/lib/supabase/types'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

function response(body: object, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function memoryKey(content: string, topic: string): string {
  return `${topic.normalize('NFC').toLocaleLowerCase()}\u0000${content.normalize('NFC')}`
}

async function existingMemoryKeys(client: SupabaseClient, userId: string): Promise<Set<string> | Response> {
  const { data, error } = await client.from('memories').select('content,topic').eq('user_id', userId).limit(1_000)
  if (error || !data) {
    console.error('memory import duplicate check failed', { code: error?.code ?? 'missing-rows' })
    return response({ error: '记忆服务暂时不可用，请稍后重试' }, 503)
  }
  return new Set(data.map(memory => memoryKey(memory.content, memory.topic ?? 'General')))
}

function excludeExistingMemories(
  memories: MemoryInput[],
  existingKeys: Set<string>,
): { fresh: MemoryInput[]; skipped: number } {
  const fresh = memories.filter(memory => !existingKeys.has(memoryKey(memory.content, memory.topic)))
  return { fresh, skipped: memories.length - fresh.length }
}

function classifyImportedMemories(
  memories: MemoryInput[],
): { values: Array<MemoryInput & { sensitive: boolean }>; prohibited: boolean; needsConsent: boolean } {
  let prohibited = false
  let needsConsent = false
  const values = memories.map(memory => {
    const classification = classifyMemorySensitivity(memory.content)
    prohibited ||= classification.prohibited
    needsConsent ||= classification.sensitive
    return { ...memory, sensitive: classification.sensitive }
  })
  return {
    values,
    prohibited,
    needsConsent,
  }
}

async function insertMemoryImport(
  client: SupabaseClient,
  userId: string,
  memories: Array<MemoryInput & { sensitive: boolean }>,
  skipped: number,
): Promise<Response> {
  const { data, error } = await client.from('memories')
    .insert(memories.map(memory => ({
      user_id: userId,
      content: memory.content,
      topic: memory.topic,
      sensitive: memory.sensitive,
    })))
    .select('id,content,topic,sensitive,created_at,updated_at')
  if (error || !data) {
    console.error('memory import failed', { code: error?.code ?? 'missing-rows' })
    return response({ error: '记忆导入失败，请稍后重试' }, 503)
  }
  return response({ memories: data, skipped }, 201)
}

export async function POST(request: Request): Promise<Response> {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return response({ error: '认证服务暂时不可用' }, 503)
  if (!auth.supabase || !auth.userId) return response({ error: '请先登录后再导入记忆' }, 401)
  const userId = auth.userId

  const gate = await enforceRequestRateLimit(auth, request)
  if (gate.response) return gate.response

  let body: unknown
  try { body = await readJson(request, { maxBytes: 256 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }

  const memories = parseMemoryImportInput(body)
  if (!memories) return response({ error: '导入内容无效；每次最多导入 100 条记忆' }, 400)

  const admin = createAdminClient()
  if (!admin) return response({ error: '记忆服务暂时不可用，请稍后重试' }, 503)
  const knownKeys = await existingMemoryKeys(admin, userId)
  if (knownKeys instanceof Response) return knownKeys
  const { fresh, skipped } = excludeExistingMemories(memories, knownKeys)
  if (fresh.length === 0) return response({ memories: [], skipped })

  const classified = classifyImportedMemories(fresh)
  if (classified.prohibited) {
    return response({ error: '导入内容含有不可保存的信息，例如政府证件号、账户号码或犯罪记录' }, 422)
  }
  if (classified.needsConsent && !await getSensitiveMemoryEnabled(auth)) {
    return response({ error: '导入内容含有敏感记忆。请先在记忆设置中开启敏感记忆保存。' }, 409)
  }
  return insertMemoryImport(admin, userId, classified.values, skipped)
}
