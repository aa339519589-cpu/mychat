import { createClient, type SupabaseClient } from '@supabase/supabase-js'

type ServerEnvironment = {
  [key: string]: string | undefined
  NEXT_PUBLIC_SUPABASE_URL?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

type AdminConfig = {
  url: string
  serviceRoleKey: string
}

const globalAdmin = globalThis as typeof globalThis & {
  __mychatSupabaseAdmin?: SupabaseClient
}

/**
 * Resolve server-only Supabase credentials without ever exposing their values.
 * SUPABASE_URL is preferred so production can keep the project URL private too.
 */
export function resolveAdminConfig(
  environment: ServerEnvironment = process.env,
): AdminConfig | null {
  const url = environment.SUPABASE_URL?.trim()
    || environment.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !serviceRoleKey) return null
  return { url, serviceRoleKey }
}

export function isAdminConfigured(environment: ServerEnvironment = process.env): boolean {
  return resolveAdminConfig(environment) !== null
}

/** Server-only client used for infrastructure RPCs that are unavailable to browser roles. */
export function createAdminClient(): SupabaseClient | null {
  const config = resolveAdminConfig()
  if (!config) return null
  if (globalAdmin.__mychatSupabaseAdmin) return globalAdmin.__mychatSupabaseAdmin

  globalAdmin.__mychatSupabaseAdmin = createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  })
  return globalAdmin.__mychatSupabaseAdmin
}
