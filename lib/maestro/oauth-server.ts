import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

const ACCESS_TTL_SECONDS = 60 * 60
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30
const CODE_TTL_SECONDS = 5 * 60
const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 365
const DEFAULT_SCOPE = "maestro"
const ALLOWED_SCOPES = new Set(["maestro", "offline_access"])

type SignedKind = "client" | "code" | "access" | "refresh"

type ClientPayload = {
  kind: "client"
  name: string
  redirectUris: string[]
  iat: number
  exp: number
  nonce: string
}

type CodePayload = {
  kind: "code"
  sub: string
  clientHash: string
  redirectUri: string
  codeChallenge: string
  scope: string
  audience: string
  iat: number
  exp: number
  nonce: string
}

type AccessPayload = {
  kind: "access"
  sub: string
  clientHash: string
  scope: string
  audience: string
  iat: number
  exp: number
  nonce: string
}

type RefreshPayload = {
  kind: "refresh"
  sub: string
  clientHash: string
  scope: string
  audience: string
  iat: number
  exp: number
  nonce: string
}

type AnyPayload = ClientPayload | CodePayload | AccessPayload | RefreshPayload

export type MaestroAuthorizationRequest = {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scope: string
  audience: string
}

function secret(): string {
  const value = process.env.MAESTRO_RUNNER_KEY?.trim()
  if (!value || value.length < 32) throw new Error("MAESTRO_RUNNER_KEY must be configured for Maestro OAuth")
  return value
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url")
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function prefix(kind: SignedKind): string {
  return kind === "client" ? "mccl" : kind === "code" ? "mccd" : kind === "access" ? "mcat" : "mcrt"
}

function signPayload<T extends AnyPayload>(payload: T): string {
  const encoded = base64url(JSON.stringify(payload))
  const head = `${prefix(payload.kind)}.${encoded}`
  const signature = createHmac("sha256", secret()).update(`maestro-oauth-v1:${head}`).digest("base64url")
  return `${head}.${signature}`
}

function verifyPayload<T extends AnyPayload>(token: string, kind: T["kind"]): T | null {
  const parts = token.split(".")
  if (parts.length !== 3 || parts[0] !== prefix(kind)) return null
  const head = `${parts[0]}.${parts[1]}`
  const expected = createHmac("sha256", secret()).update(`maestro-oauth-v1:${head}`).digest()
  let actual: Buffer
  try { actual = Buffer.from(parts[2], "base64url") } catch { return null }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  let payload: AnyPayload
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as AnyPayload } catch { return null }
  if (!payload || payload.kind !== kind || !Number.isFinite(payload.exp) || payload.exp < nowSeconds()) return null
  return payload as T
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol === "https:") return true
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
  } catch { return false }
}

function normalizeScopes(raw: string | null | undefined): string | null {
  const requested = (raw || DEFAULT_SCOPE).split(/\s+/).filter(Boolean)
  if (!requested.length) return DEFAULT_SCOPE
  if (requested.some(scope => !ALLOWED_SCOPES.has(scope))) return null
  if (!requested.includes(DEFAULT_SCOPE)) requested.unshift(DEFAULT_SCOPE)
  return [...new Set(requested)].join(" ")
}

function clientHash(clientId: string): string {
  return hash(clientId)
}

export function maestroOAuthAuthorizationServerMetadata(origin: string) {
  const issuer = origin.replace(/\/+$/, "")
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    scopes_supported: ["maestro", "offline_access"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  }
}

export function registerMaestroOAuthClient(input: unknown) {
  const row = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null
  const redirectUris = Array.isArray(row?.redirect_uris)
    ? row!.redirect_uris.filter((value): value is string => typeof value === "string" && validRedirectUri(value)).slice(0, 16)
    : []
  if (!redirectUris.length) throw new Error("redirect_uris must contain at least one valid HTTPS URI")
  const requestedAuthMethod = typeof row?.token_endpoint_auth_method === "string" ? row.token_endpoint_auth_method : "none"
  if (requestedAuthMethod !== "none") throw new Error("Only public PKCE clients are supported")
  const name = typeof row?.client_name === "string" && row.client_name.trim() ? row.client_name.trim().slice(0, 200) : "ChatGPT"
  const now = nowSeconds()
  const clientId = signPayload<ClientPayload>({
    kind: "client",
    name,
    redirectUris: [...new Set(redirectUris)],
    iat: now,
    exp: now + CLIENT_TTL_SECONDS,
    nonce: randomBytes(12).toString("base64url"),
  })
  return {
    client_id: clientId,
    client_id_issued_at: now,
    client_secret_expires_at: 0,
    redirect_uris: [...new Set(redirectUris)],
    client_name: name,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }
}

export function maestroOAuthClientName(clientId: string): string {
  return verifyPayload<ClientPayload>(clientId, "client")?.name || "ChatGPT"
}

export function parseMaestroAuthorizationRequest(params: URLSearchParams, origin: string): MaestroAuthorizationRequest {
  if (params.get("response_type") !== "code") throw new Error("response_type must be code")
  const clientId = params.get("client_id")?.trim() || ""
  const client = verifyPayload<ClientPayload>(clientId, "client")
  if (!client) throw new Error("invalid client_id")
  const redirectUri = params.get("redirect_uri")?.trim() || ""
  if (!client.redirectUris.includes(redirectUri)) throw new Error("redirect_uri was not registered")
  const codeChallenge = params.get("code_challenge")?.trim() || ""
  if (!codeChallenge || params.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 is required")
  const scope = normalizeScopes(params.get("scope"))
  if (!scope) throw new Error("unsupported scope")
  const resource = params.get("resource")?.trim()
  const expectedResource = `${origin.replace(/\/+$/, "")}/api/maestro/mcp`
  if (resource && resource !== expectedResource) throw new Error("invalid resource")
  return {
    clientId,
    redirectUri,
    state: params.get("state") || "",
    codeChallenge,
    scope,
    audience: expectedResource,
  }
}

export function issueMaestroAuthorizationCode(request: MaestroAuthorizationRequest, userId: string): string {
  const now = nowSeconds()
  return signPayload<CodePayload>({
    kind: "code",
    sub: userId,
    clientHash: clientHash(request.clientId),
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    scope: request.scope,
    audience: request.audience,
    iat: now,
    exp: now + CODE_TTL_SECONDS,
    nonce: randomBytes(18).toString("base64url"),
  })
}

function issueAccessAndRefresh(code: Pick<CodePayload, "sub" | "clientHash" | "scope" | "audience">) {
  const now = nowSeconds()
  const accessToken = signPayload<AccessPayload>({
    kind: "access",
    sub: code.sub,
    clientHash: code.clientHash,
    scope: code.scope,
    audience: code.audience,
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
    nonce: randomBytes(18).toString("base64url"),
  })
  const refreshToken = signPayload<RefreshPayload>({
    kind: "refresh",
    sub: code.sub,
    clientHash: code.clientHash,
    scope: code.scope,
    audience: code.audience,
    iat: now,
    exp: now + REFRESH_TTL_SECONDS,
    nonce: randomBytes(18).toString("base64url"),
  })
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: code.scope,
  }
}

export function exchangeMaestroAuthorizationCode(input: URLSearchParams) {
  const clientId = input.get("client_id")?.trim() || ""
  if (!verifyPayload<ClientPayload>(clientId, "client")) throw new Error("invalid client_id")
  const code = verifyPayload<CodePayload>(input.get("code")?.trim() || "", "code")
  if (!code || code.clientHash !== clientHash(clientId)) throw new Error("invalid authorization code")
  if ((input.get("redirect_uri")?.trim() || "") !== code.redirectUri) throw new Error("redirect_uri mismatch")
  const verifier = input.get("code_verifier")?.trim() || ""
  if (verifier.length < 43 || verifier.length > 128 || hash(verifier) !== code.codeChallenge) throw new Error("invalid code_verifier")
  return issueAccessAndRefresh(code)
}

export function refreshMaestroAccessToken(input: URLSearchParams) {
  const clientId = input.get("client_id")?.trim() || ""
  if (!verifyPayload<ClientPayload>(clientId, "client")) throw new Error("invalid client_id")
  const refresh = verifyPayload<RefreshPayload>(input.get("refresh_token")?.trim() || "", "refresh")
  if (!refresh || refresh.clientHash !== clientHash(clientId)) throw new Error("invalid refresh_token")
  return issueAccessAndRefresh(refresh)
}

export function verifyMaestroOAuthAccessToken(token: string, audience: string): { userId: string; scope: string } | null {
  const access = verifyPayload<AccessPayload>(token, "access")
  if (!access || access.audience !== audience || !access.scope.split(/\s+/).includes(DEFAULT_SCOPE)) return null
  return { userId: access.sub, scope: access.scope }
}

export function oauthError(message: string, status = 400): Response {
  return Response.json({ error: "invalid_request", error_description: message }, {
    status,
    headers: { "cache-control": "no-store" },
  })
}
