import { apiErrorResponseV1 } from '@/lib/api/errors'
import { generatedMediaKeyFromRoute, proxyGeneratedMedia } from '@/lib/api/generated-media'
import { resolveAuth } from '@/lib/api/guard'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  context: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const auth = await resolveAuth()
  if (auth.authUnavailable) return apiErrorResponseV1(request, {
    status: 503,
    code: 'AUTH_DEPENDENCY_UNAVAILABLE',
    message: '认证服务暂时不可用',
    retryable: true,
    headers: { 'Retry-After': '5' },
  })
  if (!auth.userId) return apiErrorResponseV1(request, {
    status: 401,
    code: 'AUTH_REQUIRED',
    message: '请先登录',
    retryable: false,
  })
  const objectKey = generatedMediaKeyFromRoute((await context.params).key)
  if (!objectKey || objectKey.split('/')[0] !== auth.userId) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
  }
  return proxyGeneratedMedia(request, auth.userId, objectKey)
}
