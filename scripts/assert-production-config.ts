import { resolveRuntimeConfiguration } from '../lib/runtime-config'

resolveRuntimeConfiguration()

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

async function fetchJson(url: string) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    })
    const text = await response.text()
    let json: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
    } catch {}
    return {
      url,
      status: response.status,
      ok: response.ok,
      json,
      preview: json ? null : text.slice(0, 300),
    }
  } catch (error) {
    return {
      url,
      status: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function probeMaestroOAuth() {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (!raw) {
    console.warn('[maestro-oauth-probe] NEXT_PUBLIC_SUPABASE_URL is missing')
    return
  }

  const base = trimSlash(raw)
  const oauth = await fetchJson(`${base}/.well-known/oauth-authorization-server/auth/v1`)
  const oidc = await fetchJson(`${base}/auth/v1/.well-known/openid-configuration`)

  const oauthJson = 'json' in oauth ? oauth.json : null
  const oidcJson = 'json' in oidc ? oidc.json : null

  const summary = {
    oauthDiscovery: {
      url: oauth.url,
      status: oauth.status,
      ok: oauth.ok,
      issuer: oauthJson?.issuer ?? null,
      authorizationEndpoint: oauthJson?.authorization_endpoint ?? null,
      tokenEndpoint: oauthJson?.token_endpoint ?? null,
      registrationEndpoint: oauthJson?.registration_endpoint ?? null,
      scopesSupported: oauthJson?.scopes_supported ?? null,
      grantTypesSupported: oauthJson?.grant_types_supported ?? null,
      responseTypesSupported: oauthJson?.response_types_supported ?? null,
      codeChallengeMethodsSupported: oauthJson?.code_challenge_methods_supported ?? null,
      error: 'error' in oauth ? oauth.error : null,
      preview: 'preview' in oauth ? oauth.preview : null,
    },
    oidcDiscovery: {
      url: oidc.url,
      status: oidc.status,
      ok: oidc.ok,
      issuer: oidcJson?.issuer ?? null,
      registrationEndpoint: oidcJson?.registration_endpoint ?? null,
      scopesSupported: oidcJson?.scopes_supported ?? null,
      error: 'error' in oidc ? oidc.error : null,
      preview: 'preview' in oidc ? oidc.preview : null,
    },
  }

  console.log(`[maestro-oauth-probe] ${JSON.stringify(summary)}`)
}

void probeMaestroOAuth()
