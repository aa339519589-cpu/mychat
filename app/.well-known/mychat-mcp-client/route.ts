import { oauthClientMetadata, CONNECTOR_CLIENT_DOCUMENT } from '@/lib/mcp/connector-oauth-state'
export async function GET() {
  return Response.json({ ...oauthClientMetadata(), client_id: CONNECTOR_CLIENT_DOCUMENT },
    { headers: { 'Cache-Control': 'public, max-age=3600' } })
}
