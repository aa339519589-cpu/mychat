import { createAdminClient } from '@/lib/supabase/admin'
import type { Database } from '@/lib/supabase/database.types'
import { enforceRequestRateLimit, resolveAuth, type AuthCtx, type RequestRateGate } from '@/lib/api/guard'
import { readJson, RequestError } from '@/lib/api/request'
import { parseMemoryInput } from '@/lib/api/memory-input'
import { classifyMemorySensitivity } from '@/lib/api/memory-sensitivity'

type MemoryRow = Pick<
  Database['public']['Tables']['memories']['Row'],
  'id' | 'content' | 'created_at' | 'updated_at'
> & { topic?: string; sensitive?: boolean }
type MemoryAttributes = { topic?: string; sensitive: boolean }
type MemoryId = Pick<MemoryRow, 'id'>
type StoreError = { code?: string } | null
type StoreResult<T> = { data: T | null; error: StoreError }

export type UserMemoryStore = {
  list(userId: string): Promise<StoreResult<MemoryRow[]>>
  create(userId: string, content: string, attributes: MemoryAttributes): Promise<StoreResult<MemoryRow>>
  update(userId: string, id: string, content: string, updatedAt: string, attributes: MemoryAttributes): Promise<StoreResult<MemoryRow>>
  delete(userId: string, id: string): Promise<StoreResult<MemoryId>>
  deleteAll(userId: string): Promise<StoreResult<MemoryId[] | number>>
}

export type MemoryManagementDependencies = {
  resolveAuth: (request: Request) => Promise<AuthCtx>
  createStore: () => UserMemoryStore | null
  readBody: (request: Request, options: { maxBytes: number }) => Promise<unknown>
  now: () => Date
  rateLimit: (auth: AuthCtx, request: Request) => Promise<RequestRateGate>
  sensitiveEnabled: (userId: string) => Promise<boolean>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY_BYTES = 128 * 1024
const MEMORY_COLUMNS = 'id,content,topic,sensitive,created_at,updated_at' as const

function storeFromAdmin(): UserMemoryStore | null {
  const admin = createAdminClient()
  if (!admin) return null
  return {
    list: async userId => {
      const { data, error } = await admin.from('memories')
        .select(MEMORY_COLUMNS)
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(200)
      return { data, error }
    },
    create: async (userId, content, attributes) => {
      const { data, error } = await admin.from('memories')
        .insert({ user_id: userId, content, ...attributes })
        .select(MEMORY_COLUMNS)
        .single()
      return { data, error }
    },
    update: async (userId, id, content, updatedAt, attributes) => {
      const { data, error } = await admin.from('memories')
        .update({ content, updated_at: updatedAt, ...attributes })
        .eq('id', id)
        .eq('user_id', userId)
        .select(MEMORY_COLUMNS)
        .maybeSingle()
      return { data, error }
    },
    delete: async (userId, id) => {
      const { data, error } = await admin.from('memories')
        .delete()
        .eq('id', id)
        .eq('user_id', userId)
        .select('id')
        .maybeSingle()
      return { data, error }
    },
    deleteAll: async userId => {
      const { data, error } = await admin.rpc('reset_user_memories', { input_user_id: userId })
      return { data, error }
    },
  }
}

const DEFAULT_DEPENDENCIES: MemoryManagementDependencies = {
  resolveAuth,
  createStore: storeFromAdmin,
  readBody: (request, options) => readJson(request, options),
  now: () => new Date(),
  rateLimit: enforceRequestRateLimit,
  sensitiveEnabled: async userId => {
    const admin = createAdminClient()
    if (!admin) return false
    const { data, error } = await admin.from('profiles')
      .select('sensitive_memory_enabled').eq('user_id', userId).maybeSingle()
    return !error && data?.sensitive_memory_enabled === true
  },
}

function json(body: object, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function logStoreFailure(operation: string, error: StoreError): void {
  console.error(`memory ${operation} failed`, { code: error?.code ?? 'unknown' })
}

async function authenticate(
  request: Request,
  dependencies: MemoryManagementDependencies,
): Promise<{ userId: string } | { response: Response }> {
  const auth = await dependencies.resolveAuth(request)
  if (!auth.userId || auth.authUnavailable) {
    return {
      response: json(
        { error: auth.authUnavailable ? '认证服务暂时不可用，请稍后重试' : '请先登录后再使用记忆' },
        auth.authUnavailable ? 503 : 401,
      ),
    }
  }
  if (request.method !== 'GET') {
    const gate = await dependencies.rateLimit(auth, request)
    if (gate.response) return { response: gate.response }
  }
  return { userId: auth.userId }
}

async function memoryWritePolicy(content: string, userId: string, dependencies: MemoryManagementDependencies): Promise<Response | null> {
  const classification = classifyMemorySensitivity(content)
  if (classification.prohibited) return json({ error: '不会保存政府证件号码、犯罪记录、账户号码或移民身份等信息' }, 422)
  if (classification.sensitive && !await dependencies.sensitiveEnabled(userId)) {
    return json({ error: '请先在记忆设置中明确开启敏感记忆保存' }, 409)
  }
  return null
}

async function readContent(
  request: Request,
  dependencies: MemoryManagementDependencies,
  userId: string,
): Promise<{ content: string; attributes: MemoryAttributes } | { response: Response }> {
  let body: unknown
  try {
    body = await dependencies.readBody(request, { maxBytes: MAX_BODY_BYTES })
  } catch (error) {
    const tooLarge = error instanceof RequestError && error.status === 413
    return {
      response: json(
        { error: tooLarge ? '记忆内容过长，请缩短后重试' : '记忆请求格式无效' },
        tooLarge ? 413 : 400,
      ),
    }
  }
  const input = parseMemoryInput(body)
  if (!input) return { response: json({ error: '记忆内容或主题格式无效，内容最多 20,000 个字符' }, 400) }
  const policyError = await memoryWritePolicy(input.content, userId, dependencies)
  if (policyError) return { response: policyError }
  const providedTopic = Object.hasOwn(body as object, 'topic')
  return { content: input.content, attributes: {
    ...(request.method === 'POST' || providedTopic ? { topic: input.topic } : {}),
    sensitive: classifyMemorySensitivity(input.content).sensitive,
  } }
}

function availableStore(
  dependencies: MemoryManagementDependencies,
): UserMemoryStore | Response {
  try {
    return dependencies.createStore() ?? json({ error: '记忆服务暂时不可用，请稍后重试' }, 503)
  } catch {
    return json({ error: '记忆服务暂时不可用，请稍后重试' }, 503)
  }
}

export async function handleMemoryCollection(
  request: Request,
  dependencyOverrides: Partial<MemoryManagementDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const auth = await authenticate(request, dependencies)
  if ('response' in auth) return auth.response
  const store = availableStore(dependencies)
  if (store instanceof Response) return store

  return collectionOperation(request, dependencies, store, auth.userId)
}

async function collectionOperation(
  request: Request,
  dependencies: MemoryManagementDependencies,
  store: UserMemoryStore,
  userId: string,
): Promise<Response> {
  switch (request.method) {
    case 'GET': return listMemories(store, userId)
    case 'POST': return createMemory(request, dependencies, store, userId)
    case 'DELETE': return deleteAllMemories(store, userId)
    default: return json({ error: '不支持的记忆操作' }, 405)
  }
}

async function listMemories(store: UserMemoryStore, userId: string): Promise<Response> {
  try {
    const result = await store.list(userId)
    if (result.error) {
      logStoreFailure('list', result.error)
      return json({ error: '记忆读取失败，请稍后重试' }, 500)
    }
    return json({ memories: result.data ?? [] })
  } catch (error) {
    logStoreFailure('list', error as StoreError)
    return json({ error: '记忆读取失败，请稍后重试' }, 500)
  }
}

async function createMemory(
  request: Request,
  dependencies: MemoryManagementDependencies,
  store: UserMemoryStore,
  userId: string,
): Promise<Response> {
  const input = await readContent(request, dependencies, userId)
  if ('response' in input) return input.response
  try {
    const result = await store.create(userId, input.content, input.attributes)
    if (result.error || !result.data) {
      logStoreFailure('create', result.error)
      return json({ error: '记忆保存失败，请稍后重试' }, 500)
    }
    return json({ memory: result.data }, 201)
  } catch (error) {
    logStoreFailure('create', error as StoreError)
    return json({ error: '记忆保存失败，请稍后重试' }, 500)
  }
}

async function deleteAllMemories(store: UserMemoryStore, userId: string): Promise<Response> {
  try {
    const result = await store.deleteAll(userId)
    if (result.error) {
      logStoreFailure('delete-all', result.error)
      return json({ error: '记忆清除失败，请稍后重试' }, 500)
    }
    const count = typeof result.data === 'number' ? result.data : result.data?.length
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
      return json({ error: '记忆清除结果无效，请稍后重试' }, 500)
    }
    return json({ deleted: count })
  } catch (error) {
    logStoreFailure('delete-all', error as StoreError)
    return json({ error: '记忆清除失败，请稍后重试' }, 500)
  }
}

export async function handleMemoryItem(
  request: Request,
  memoryId: string,
  dependencyOverrides: Partial<MemoryManagementDependencies> = {},
): Promise<Response> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const auth = await authenticate(request, dependencies)
  if ('response' in auth) return auth.response
  if (!UUID.test(memoryId)) return json({ error: '记忆标识无效' }, 400)
  const store = availableStore(dependencies)
  if (store instanceof Response) return store

  if (request.method === 'PATCH') {
    const input = await readContent(request, dependencies, auth.userId)
    if ('response' in input) return input.response
    try {
      const result = await store.update(
        auth.userId,
        memoryId,
        input.content,
        dependencies.now().toISOString(),
        input.attributes,
      )
      if (result.error) {
        logStoreFailure('update', result.error)
        return json({ error: '记忆修改失败，请稍后重试' }, 500)
      }
      return result.data
        ? json({ memory: result.data })
        : json({ error: '记忆不存在或无法修改' }, 404)
    } catch (error) {
      logStoreFailure('update', error as StoreError)
      return json({ error: '记忆修改失败，请稍后重试' }, 500)
    }
  }

  if (request.method === 'DELETE') {
    try {
      const result = await store.delete(auth.userId, memoryId)
      if (result.error) {
        logStoreFailure('delete', result.error)
        return json({ error: '记忆删除失败，请稍后重试' }, 500)
      }
      return result.data
        ? json({ ok: true, id: result.data.id })
        : json({ error: '记忆不存在或无法删除' }, 404)
    } catch (error) {
      logStoreFailure('delete', error as StoreError)
      return json({ error: '记忆删除失败，请稍后重试' }, 500)
    }
  }

  return json({ error: '不支持的记忆操作' }, 405)
}
