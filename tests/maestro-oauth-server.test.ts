import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  exchangeMaestroAuthorizationCode,
  issueMaestroAuthorizationCode,
  maestroOAuthAuthorizationServerMetadata,
  parseMaestroAuthorizationRequest,
  refreshMaestroAccessToken,
  registerMaestroOAuthClient,
  verifyMaestroOAuthAccessToken,
} from "../lib/maestro/oauth-server"

process.env.MAESTRO_RUNNER_KEY = "test-maestro-oauth-key-0123456789-abcdefghijklmnopqrstuvwxyz"

const ORIGIN = "https://mychat.example"
const RESOURCE = `${ORIGIN}/api/maestro/mcp`
const REDIRECT = "https://chatgpt.com/aip/oauth/callback"

function pkce(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

function registeredClient() {
  return registerMaestroOAuthClient({
    redirect_uris: [REDIRECT],
    client_name: "ChatGPT",
    token_endpoint_auth_method: "none",
  })
}

test("Maestro OAuth metadata advertises DCR, PKCE and refresh tokens", () => {
  const metadata = maestroOAuthAuthorizationServerMetadata(ORIGIN)
  assert.equal(metadata.issuer, ORIGIN)
  assert.equal(metadata.authorization_endpoint, `${ORIGIN}/oauth/authorize`)
  assert.equal(metadata.token_endpoint, `${ORIGIN}/oauth/token`)
  assert.equal(metadata.registration_endpoint, `${ORIGIN}/oauth/register`)
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"])
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"])
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"])
})

test("dynamic client registration creates a public PKCE client", () => {
  const client = registeredClient()
  assert.match(client.client_id, /^mccl\./)
  assert.equal(client.client_secret_expires_at, 0)
  assert.equal(client.token_endpoint_auth_method, "none")
  assert.deepEqual(client.redirect_uris, [REDIRECT])
})

test("authorization request binds the registered redirect, PKCE and MCP resource", () => {
  const client = registeredClient()
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: pkce(verifier),
    code_challenge_method: "S256",
    scope: "maestro offline_access",
    resource: RESOURCE,
    state: "state-1",
  })
  const parsed = parseMaestroAuthorizationRequest(params, ORIGIN)
  assert.equal(parsed.redirectUri, REDIRECT)
  assert.equal(parsed.audience, RESOURCE)
  assert.equal(parsed.state, "state-1")
  assert.throws(() => parseMaestroAuthorizationRequest(new URLSearchParams({
    ...Object.fromEntries(params.entries()),
    redirect_uri: "https://evil.example/callback",
  }), ORIGIN), /redirect_uri/)
})

test("authorization code exchange verifies PKCE and issues a user-bound access token", () => {
  const client = registeredClient()
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
  const request = parseMaestroAuthorizationRequest(new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: pkce(verifier),
    code_challenge_method: "S256",
    scope: "maestro offline_access",
    resource: RESOURCE,
  }), ORIGIN)
  const code = issueMaestroAuthorizationCode(request, "user-123")
  const exchanged = exchangeMaestroAuthorizationCode(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code,
    code_verifier: verifier,
  }))
  assert.equal(exchanged.token_type, "Bearer")
  assert.ok(exchanged.refresh_token)
  assert.deepEqual(verifyMaestroOAuthAccessToken(exchanged.access_token, RESOURCE), {
    userId: "user-123",
    scope: "maestro offline_access",
  })
  assert.equal(verifyMaestroOAuthAccessToken(exchanged.access_token, `${ORIGIN}/wrong`), null)
})

test("wrong PKCE verifier is rejected", () => {
  const client = registeredClient()
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
  const request = parseMaestroAuthorizationRequest(new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: pkce(verifier),
    code_challenge_method: "S256",
    resource: RESOURCE,
  }), ORIGIN)
  const code = issueMaestroAuthorizationCode(request, "user-123")
  assert.throws(() => exchangeMaestroAuthorizationCode(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code,
    code_verifier: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  })), /code_verifier/)
})

test("refresh token renews a valid access token for the same user and resource", () => {
  const client = registeredClient()
  const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
  const request = parseMaestroAuthorizationRequest(new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: pkce(verifier),
    code_challenge_method: "S256",
    scope: "maestro offline_access",
    resource: RESOURCE,
  }), ORIGIN)
  const code = issueMaestroAuthorizationCode(request, "user-refresh")
  const first = exchangeMaestroAuthorizationCode(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code,
    code_verifier: verifier,
  }))
  const renewed = refreshMaestroAccessToken(new URLSearchParams({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: first.refresh_token,
  }))
  assert.equal(verifyMaestroOAuthAccessToken(renewed.access_token, RESOURCE)?.userId, "user-refresh")
})
