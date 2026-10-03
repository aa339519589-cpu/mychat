import { oauthStore, oauthStateHash } from '@/lib/mcp/connector-oauth-store'
import { finishConnectorAuthorization } from '@/lib/mcp/connector-oauth-flow'

export async function GET(request: Request) {
  const destination = new URL('mychat://connectors/oauth')
  try {
    const id = await finishConnectorAuthorization(oauthStore(), new URL(request.url).searchParams)
    destination.searchParams.set('connectorId', id)
    destination.searchParams.set('attemptId', oauthStateHash(new URL(request.url).searchParams.get('state')!))
    destination.searchParams.set('status', 'success')
  } catch {
    // OAuth error descriptions and authorization codes must never enter a deep link or log.
    destination.searchParams.set('status', 'failed')
  }
  return new Response(null, { status: 303, headers: { Location: destination.toString(),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
}
