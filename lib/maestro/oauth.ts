function trimSlash(value: string): string {
  return value.replace(/\/+$/, "")
}

export function maestroAuthorizationServer(origin: string): string {
  return trimSlash(origin)
}

export function maestroResourceUrl(origin: string): string {
  return `${trimSlash(origin)}/api/maestro/mcp`
}

export function maestroResourceMetadataUrl(origin: string): string {
  return `${trimSlash(origin)}/.well-known/oauth-protected-resource/api/maestro/mcp`
}

export function maestroProtectedResourceMetadata(origin: string) {
  return {
    resource: maestroResourceUrl(origin),
    authorization_servers: [maestroAuthorizationServer(origin)],
    scopes_supported: ["maestro", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "My che che. Maestro Runner",
  }
}

export function maestroUnauthorized(origin: string, description = "Authentication required"): Response {
  const resourceMetadata = maestroResourceMetadataUrl(origin)
  const escaped = description.replace(/["\\]/g, "")
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": `Bearer error="invalid_token", error_description="${escaped}", resource_metadata="${resourceMetadata}"`,
    },
  })
}
