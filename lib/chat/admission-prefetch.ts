import type { SupabaseServer } from '@/lib/api/guard'
import type { ModelEndpointRow } from '@/lib/model-endpoint-server'

// Start a bounded, RLS-protected configuration read beside getUser. No
// credentials are decrypted and no admission occurs until full auth succeeds.
// A failed/truncated prefetch falls back to the ordinary owned-row lookup.
export async function prefetchChatEndpoints(client: SupabaseServer): Promise<ModelEndpointRow[] | null> {
  try {
    const { data, error } = await client.from('endpoints')
      .select('id,user_id,name,protocol,base_url,api_key,model,output_kind,auth_type,created_at,updated_at')
      .limit(256)
    return error ? null : data as ModelEndpointRow[] | null
  } catch { return null }
}
