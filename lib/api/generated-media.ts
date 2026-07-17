import type { SupabaseClient } from '@/lib/supabase/types'
import {
  generatedMediaObjectKey,
  normalizeGeneratedMediaList,
} from '@/lib/generated-media'
import { createAdminClient, resolveAdminConfig } from '@/lib/supabase/admin'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ASSET = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.(?:png|jpg|webp|gif|mp4|webm|mov)$/
const SINGLE_RANGE = /^bytes=(?:\d+-\d*|-\d+)$/

export type GeneratedMediaAccess = 'allowed' | 'not_found' | 'unavailable'

export type GeneratedMediaProxyDependencies = {
  createAdminClient: () => SupabaseClient | null
  resolveAdminConfig: () => { url: string; serviceRoleKey: string } | null
  fetcher: typeof fetch
  authorize: (client: SupabaseClient, userId: string, objectKey: string) => Promise<GeneratedMediaAccess>
}

const DEFAULT_DEPENDENCIES: GeneratedMediaProxyDependencies = {
  createAdminClient,
  resolveAdminConfig,
  fetcher: globalThis.fetch,
  authorize: authorizeGeneratedMediaObject,
}

export function generatedMediaKeyFromRoute(segments: readonly string[]): string | null {
  if (segments.length !== 5 || segments[4] !== 'content'
    || !UUID.test(segments[0]) || !UUID.test(segments[1]) || !UUID.test(segments[2])
    || !ASSET.test(segments[3])) return null
  return segments.slice(0, 4).join('/')
}

export function generatedMediaRange(request: Request): string | null | false {
  const value = request.headers.get('range')
  if (value === null) return null
  return value.length <= 100 && SINGLE_RANGE.test(value) ? value : false
}

export async function authorizeGeneratedMediaObject(
  client: SupabaseClient,
  userId: string,
  objectKey: string,
): Promise<GeneratedMediaAccess> {
  const parts = objectKey.split('/')
  if (parts.length !== 4 || parts[0] !== userId) return 'not_found'
  const [principalId, conversationId, generationId] = parts
  const assetQuery = await client.from('job_assets')
    .select('state')
    .eq('principal_id', principalId)
    .eq('object_key', objectKey)
    .maybeSingle()
  if (assetQuery.error) return 'unavailable'
  if (assetQuery.data) return assetQuery.data.state === 'canonical' ? 'allowed' : 'not_found'

  // Compatibility for media created before fenced asset receipts existed.
  const legacyQuery = await client.from('chat_generations')
    .select('status, media')
    .eq('id', generationId)
    .eq('user_id', principalId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (legacyQuery.error) return 'unavailable'
  if (!legacyQuery.data || legacyQuery.data.status !== 'completed') return 'not_found'
  return normalizeGeneratedMediaList(legacyQuery.data.media)
    .some(media => generatedMediaObjectKey(media.url) === objectKey)
    ? 'allowed'
    : 'not_found'
}

function errorResponse(status: number, retryAfter?: string): Response {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (retryAfter) headers.set('Retry-After', retryAfter)
  return new Response(null, { status, headers })
}

function upstreamUrl(baseUrl: string, objectKey: string): URL | null {
  try {
    const base = new URL(baseUrl)
    if (base.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && base.protocol === 'http:')) {
      return null
    }
    const encoded = objectKey.split('/').map(encodeURIComponent).join('/')
    return new URL(`/storage/v1/object/authenticated/generated-media/${encoded}`, base)
  } catch {
    return null
  }
}

/** Stream a private canonical object without exposing a signed URL or service credential. */
export async function proxyGeneratedMedia(
  request: Request,
  userId: string,
  objectKey: string,
  dependencyOverrides: Partial<GeneratedMediaProxyDependencies> = {},
): Promise<Response> {
  if (objectKey.split('/')[0] !== userId) return errorResponse(404)
  const range = generatedMediaRange(request)
  if (range === false) return errorResponse(416)
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  let client: SupabaseClient | null
  let config: { url: string; serviceRoleKey: string } | null
  try {
    client = dependencies.createAdminClient()
    config = dependencies.resolveAdminConfig()
  } catch {
    return errorResponse(503, '5')
  }
  if (!client || !config) return errorResponse(503, '5')
  const access = await dependencies.authorize(client, userId, objectKey).catch(() => 'unavailable' as const)
  if (access === 'not_found') return errorResponse(404)
  if (access !== 'allowed') return errorResponse(503, '5')
  const url = upstreamUrl(config.url, objectKey)
  if (!url) return errorResponse(503, '5')

  const upstreamHeaders = new Headers({
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
  })
  if (range) upstreamHeaders.set('range', range)
  let upstream: Response
  try {
    upstream = await dependencies.fetcher(url, {
      method: 'GET',
      headers: upstreamHeaders,
      redirect: 'error',
      signal: request.signal,
    })
  } catch {
    return errorResponse(502, '2')
  }
  if (upstream.status === 404) return errorResponse(404)
  if (upstream.status === 416) {
    const response = errorResponse(416)
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) response.headers.set('Content-Range', contentRange)
    return response
  }
  if (upstream.status !== 200 && upstream.status !== 206) return errorResponse(502, '2')
  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (!contentType || (!contentType.startsWith('image/') && !contentType.startsWith('video/'))) {
    await upstream.body?.cancel().catch(() => undefined)
    return errorResponse(502, '2')
  }
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  })
  for (const name of ['accept-ranges', 'content-length', 'content-range', 'etag']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}
