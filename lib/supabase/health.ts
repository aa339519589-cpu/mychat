import { createAdminClient, isAdminConfigured } from './admin'

type HealthEnvironment = {
  [key: string]: string | undefined
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  RENDER_GIT_COMMIT?: string
  VERCEL_GIT_COMMIT_SHA?: string
}

type HealthRpcClient = {
  rpc: (name: string) => PromiseLike<{
    data: unknown
    error: unknown
  }>
}

export type RuntimeHealth = {
  ready: boolean
  revision: string
  checks: {
    auth: { configured: boolean; ready: boolean }
    database: { configured: boolean; ready: boolean }
    distributedRateLimit: { configured: boolean; ready: boolean }
  }
}

export function safeRevision(environment: HealthEnvironment = process.env): string {
  const raw = environment.RENDER_GIT_COMMIT?.trim()
    || environment.VERCEL_GIT_COMMIT_SHA?.trim()
  return raw && /^[a-f0-9]{7,64}$/i.test(raw) ? raw.slice(0, 12).toLowerCase() : 'unknown'
}

function isAuthConfigured(environment: HealthEnvironment): boolean {
  const hasUrl = Boolean(environment.SUPABASE_URL?.trim()
    || environment.NEXT_PUBLIC_SUPABASE_URL?.trim())
  return hasUrl && Boolean(environment.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim())
}

export async function probeDatabase(
  client: HealthRpcClient | null,
  timeoutMs = 2_000,
): Promise<boolean> {
  if (!client) return false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      // Versioned so structurally present but unusable infrastructure RPCs do
      // not let a newer application revision report ready.
      client.rpc('runtime_healthcheck_v3'),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => resolve(null), Math.max(100, timeoutMs))
      }),
    ])
    if (!result || result.error) return false
    return result.data === true
      || (Array.isArray(result.data) && result.data[0] === true)
  } catch {
    return false
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function getRuntimeHealth(
  environment: HealthEnvironment = process.env,
  client: HealthRpcClient | null = createAdminClient(),
): Promise<RuntimeHealth> {
  const authConfigured = isAuthConfigured(environment)
  const adminConfigured = isAdminConfigured(environment)
  const databaseReady = adminConfigured && await probeDatabase(client)
  return {
    ready: authConfigured && databaseReady,
    revision: safeRevision(environment),
    checks: {
      auth: { configured: authConfigured, ready: authConfigured },
      database: { configured: adminConfigured, ready: databaseReady },
      distributedRateLimit: { configured: adminConfigured, ready: databaseReady },
    },
  }
}
