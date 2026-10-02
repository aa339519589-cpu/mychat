import { createAdminClient } from '@/lib/supabase/admin'
import type { Database } from '@/lib/supabase/database.types'
import { resolveAuth, type AuthCtx } from '@/lib/api/guard'
import { readJson, RequestError } from '@/lib/api/request'

type MemoryRow = Pick<
  Database['public']['Tables']['memories']['Row'],
  'id' | 'content' | 'created_at' | 'updated_at'
>
type MemoryId = Pick<MemoryRow, 'id'>
type StoreError = { code?: string } | null
type StoreResult<T> = { data: T | null; error: StoreError }

export type UserMemoryStore = {
  list(userId: string): Promise<StoreResult<MemoryRow[]>>
  create(userId: string, content: string): Promise<StoreResult<MemoryRow>>
  update(userId: string, id: string, content: string, updatedAt: string): Promise<StoreResult<MemoryRow>>
  delete(userId: string, id: string): Promise<StoreResult<MemoryId>>
  deleteAll(userId: string): Promise<StoreResult<MemoryId[]>>
}

export type MemoryManagementDependencies = {
  resolveAuth: (request: Request) => Promise<AuthCtx>
  createStore: () => UserMemoryStore | null
  readBody: (request: Request, options: { maxBytes: number }) => Promise<unknown>
  now: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_MEMORY_LENGTH = 20_000
const MAX_BODY_BYTES = 128 * 1024
const MEMORY_COLUMNS = 'id,content,created_at,updated_at' as const

function storeFromAdmin(): UserMemoryStore | null {
  const admin = createAdminClient()
  if (!admin) return null
  return {
    list: async userId => {
      const { data, error } = await admin.from('memories')
        .select(MEMORY_COLUMNS)
        .eq('user_id', userId)
        .order('created_at', { ascending: true })
        .limit(200)
      return { data, error }
    },
    create: async (userId, content) => {
      const { data, error } = await admin.from('memories')
        .insert({ user_id: userId, content })
        .select(MEMORY_COLUMNS)
        .single()
      return { data, error }
    },
    update: async (userId, id, content, updatedAt) => {
      const { data, error } = await admin.from('memories')
        .update({ content, updated_at: updatedAt })
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
      const { data, error } = await admin.from('memories')
        .delete()
        .eq('user_id', userId)
        .select('id')
      return { data, error }
    },
  }
}

const DEFAULT_DEPENDENCIES: MemoryManagementDependencies = {
  resolveAuth,
  createStore: storeFromAdmin,
  readBody: (request, options) => readJson(request, options),
  now: () => new Date(),
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
  if (!auth.userId) {
    return {
      response: json(
        { error: auth.authUnavailable ? '认证服务暂时不可用，请稍后重试' : '请先登录后再使用记忆' },
        auth.authUnavailable ? 503 : 401,
      ),
    }
  }
  return { userId: auth.userId }
}

function parseContent(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const content = (value as { content?: unknown }).content
  if (typeof content !== 'string') return null
  const normalized = content.trim()
  return normalized.length > 0 && normalized.length <= MAX_MEMORY_LENGTH ? normalized : null
}

async function readContent(
  request: Request,
  dependencies: MemoryManagementDependencies,
): Promise<{ content: string } | { response: Response }> {
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
  const content = parseContent(body)
  if (!content) return { response: json({ error: '记忆内容为空或超过 20,000 个字符' }, 400) }
  return { content }
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
  const input = await readContent(request, dependencies)
  if ('response' in input) return input.response
  try {
    const result = await store.create(userId, input.content)
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
    return json({ deleted: result.data?.length ?? 0 })
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
    const input = await readContent(request, dependencies)
    if ('response' in input) return input.response
    try {
      const result = await store.update(
        auth.userId,
        memoryId,
        input.content,
        dependencies.now().toISOString(),
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
