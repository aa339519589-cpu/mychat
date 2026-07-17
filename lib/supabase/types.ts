import type { SupabaseClient as BaseSupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

export type SupabaseClient = BaseSupabaseClient<Database>
export type { Database, Json, Tables, TablesInsert, TablesUpdate } from './database.types'

type Functions = Database['public']['Functions']
export type RpcName = keyof Functions
export type RpcArgs<Name extends RpcName> = Functions[Name] extends { Args: infer Args } ? Args : never
export type RpcReturns<Name extends RpcName> = Functions[Name] extends { Returns: infer Returns }
  ? Returns
  : never

export type RpcError = { code?: string; message?: string }
export type RpcResponse<Returns = unknown> = {
  data: Returns | null
  error: RpcError | null
}
export type RpcRequest<Returns = unknown> = PromiseLike<RpcResponse<Returns>> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResponse<Returns>>
}

/**
 * Preserves the generated function-name/argument relationship across generic callers.
 * Supabase's generic RPC signature loses that correlation when both values are indexed
 * by another generic, so the SDK limitation is isolated at this single boundary.
 */
export function typedRpc<Name extends RpcName>(
  client: SupabaseClient,
  name: Name,
  args: RpcArgs<Name>,
): RpcRequest<RpcReturns<Name>> {
  return client.rpc(name, args as never) as unknown as RpcRequest<RpcReturns<Name>>
}
