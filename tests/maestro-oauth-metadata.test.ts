import test from "node:test"
import assert from "node:assert/strict"
import { maestroProtectedResourceMetadata, maestroUnauthorized } from "../lib/maestro/oauth"

test("OAuth resource metadata identifies the MyChat authorization server", () => {
  assert.deepEqual(maestroProtectedResourceMetadata("https://mychat.example/"), {
    resource: "https://mychat.example/api/maestro/mcp",
    authorization_servers: ["https://mychat.example"],
    scopes_supported: ["maestro", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "My che che. Maestro Runner",
  })
})

test("unauthorized OAuth response returns a protected-resource challenge", async () => {
  const response = maestroUnauthorized("https://mychat.example", 'Token "expired"')
  assert.equal(response.status, 401)
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8")
  assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/mychat\.example\/\.well-known\/oauth-protected-resource\/api\/maestro\/mcp"/)
  assert.deepEqual(await response.json(), { error: "invalid_token", error_description: 'Token "expired"' })
})
