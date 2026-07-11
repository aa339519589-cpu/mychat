import test from "node:test"
import assert from "node:assert/strict"
import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"
import { ModelEndpointError } from "../lib/llm/openai-compatible"
import {
  isEncryptedModelEndpointKey,
  openModelEndpointKey,
  sealModelEndpointKey,
  type ModelEndpointSecretContext,
} from "../lib/model-endpoint-secret"
import {
  endpointSummary,
  probeModelEndpointAuthentication,
  resolveModelEndpointKey,
  type ModelEndpointRow,
} from "../lib/model-endpoint-server"

const SECRET_A = "test-endpoint-credential-secret-a-32-chars-minimum"
const SECRET_B = "test-endpoint-credential-secret-b-32-chars-minimum"

function context(overrides: Partial<ModelEndpointSecretContext> = {}): ModelEndpointSecretContext {
  return {
    userId: "user-a",
    endpointId: "endpoint-a",
    baseUrl: "https://api.example.com/v1",
    protocol: "openai",
    authType: "bearer",
    model: "chat-model",
    ...overrides,
    outputKind: overrides.outputKind ?? "chat",
  }
}

function row(apiKey: string, overrides: Partial<ModelEndpointRow> = {}): ModelEndpointRow {
  return {
    id: "endpoint-a",
    user_id: "user-a",
    name: "Chat Model",
    protocol: "openai",
    base_url: "https://api.example.com/v1",
    api_key: apiKey,
    model: "chat-model",
    output_kind: "chat",
    auth_type: "bearer",
    ...overrides,
  }
}

function sealLegacyV1(apiKey: string, secret: string, userId: string, endpointId: string): string {
  const prefix = "model-endpoint:v1"
  const key = createHash("sha256").update(`mychat:model-endpoint:${secret}`).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(`${prefix}:${userId}:${endpointId}`, "utf8"))
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()])
  return [prefix, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".")
}

function sealLegacyV2(apiKey: string, secret: string, source: ModelEndpointSecretContext): string {
  const prefix = "model-endpoint:v2"
  const key = createHash("sha256").update(`mychat:model-endpoint:v2:${secret}`).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(JSON.stringify([
    prefix,
    source.userId,
    source.endpointId,
    source.baseUrl,
    source.protocol,
    source.authType,
    source.model,
  ]), "utf8"))
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()])
  return [prefix, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".")
}

test("v3 endpoint credentials authenticate every routing field including output kind", { concurrency: false }, t => {
  const previous = process.env.AGENT_CREDENTIAL_KEY
  process.env.AGENT_CREDENTIAL_KEY = SECRET_A
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CREDENTIAL_KEY
    else process.env.AGENT_CREDENTIAL_KEY = previous
  })

  const endpointContext = context()
  const sealed = sealModelEndpointKey("synthetic-api-key", endpointContext)
  assert.equal(isEncryptedModelEndpointKey(sealed), true)
  assert.equal(openModelEndpointKey(sealed, endpointContext), "synthetic-api-key")
  assert.equal(resolveModelEndpointKey(row(sealed), "user-a"), "synthetic-api-key")
  assert.equal(endpointSummary(row(sealed)).needsReconnect, false)
  assert.equal(endpointSummary(row(sealed)).outputKind, "chat")
  assert.throws(
    () => sealModelEndpointKey("synthetic-api-key", context({ baseUrl: "https://api.example.com/v1/" })),
    /模型端点配置无效/,
  )

  const mutations: ModelEndpointSecretContext[] = [
    context({ userId: "user-b" }),
    context({ endpointId: "endpoint-b" }),
    context({ baseUrl: "https://other.example.com/v1" }),
    context({ baseUrl: "https://api.example.com/v1/" }),
    context({ protocol: "other-protocol" }),
    context({ authType: "x-api-key" }),
    context({ model: "other-model" }),
    context({ outputKind: "image" }),
  ]
  for (const mutated of mutations) assert.equal(openModelEndpointKey(sealed, mutated), null)

  assert.equal(endpointSummary(row(sealed, { base_url: "https://other.example.com/v1" })).needsReconnect, true)
  assert.equal(endpointSummary(row(sealed, { protocol: "other-protocol" })).needsReconnect, true)
  assert.equal(endpointSummary(row(sealed, { auth_type: "x-api-key" })).needsReconnect, true)
  assert.equal(endpointSummary(row(sealed, { model: "other-model" })).needsReconnect, true)
  assert.equal(endpointSummary(row(sealed, { output_kind: "image" })).needsReconnect, true)

  process.env.AGENT_CREDENTIAL_KEY = SECRET_B
  assert.equal(endpointSummary(row(sealed)).needsReconnect, true)
  process.env.AGENT_CREDENTIAL_KEY = SECRET_A
  assert.equal(endpointSummary(row(sealed)).needsReconnect, false)
})

test("plaintext, v1, and v2 secrets require reconnect while an empty v3 no-auth key round-trips", { concurrency: false }, t => {
  const previous = process.env.AGENT_CREDENTIAL_KEY
  process.env.AGENT_CREDENTIAL_KEY = SECRET_A
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CREDENTIAL_KEY
    else process.env.AGENT_CREDENTIAL_KEY = previous
  })

  const noAuthContext = context({ authType: "none" })
  const emptySealed = sealModelEndpointKey("", noAuthContext)
  assert.equal(openModelEndpointKey(emptySealed, noAuthContext), "")
  assert.equal(endpointSummary(row(emptySealed, { auth_type: "none" })).needsReconnect, false)

  const legacy = sealLegacyV1("synthetic-legacy-key", SECRET_A, "user-a", "endpoint-a")
  const legacyV2 = sealLegacyV2("synthetic-v2-key", SECRET_A, context())
  assert.equal(isEncryptedModelEndpointKey(legacy), false)
  assert.equal(isEncryptedModelEndpointKey(legacyV2), false)
  assert.equal(openModelEndpointKey(legacy, context()), null)
  assert.equal(openModelEndpointKey(legacyV2, context()), null)
  assert.equal(endpointSummary(row(legacy)).needsReconnect, true)
  assert.equal(endpointSummary(row(legacyV2)).needsReconnect, true)
  assert.equal(endpointSummary(row("legacy-plaintext")).needsReconnect, true)
})

test("automatic chat authentication stores the first actually working auth type", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const seen: Array<{ authorization?: string; xApiKey?: string; apiKey?: string }> = []
  let mode: "x-api-key" | "none" | "upstream-error" = "x-api-key"
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push({
      authorization: request.headers.authorization,
      xApiKey: request.headers["x-api-key"] as string | undefined,
      apiKey: request.headers["api-key"] as string | undefined,
    })
    if (mode === "upstream-error") {
      response.writeHead(400, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "invalid request" } }))
      return
    }
    const hasAuthHeader = Boolean(
      request.headers.authorization || request.headers["x-api-key"] || request.headers["api-key"],
    )
    const accepted = mode === "x-api-key" ? Boolean(request.headers["x-api-key"]) : !hasAuthHeader
    if (!accepted) {
      response.writeHead(401, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "wrong auth scheme" } }))
      return
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\ndata: [DONE]\n\n`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}/v1`

  assert.equal(await probeModelEndpointAuthentication({
    baseUrl,
    apiKey: "synthetic-test-key",
    authType: "auto",
    model: "chat-model",
  }), "x-api-key")
  assert.equal(seen.length, 2)
  assert.equal(seen[0].authorization, "Bearer synthetic-test-key")
  assert.equal(seen[1].xApiKey, "synthetic-test-key")

  mode = "none"
  seen.length = 0
  assert.equal(await probeModelEndpointAuthentication({
    baseUrl,
    apiKey: "synthetic-test-key",
    authType: "auto",
    model: "chat-model",
  }), "none")
  assert.deepEqual(seen.map(item => [Boolean(item.authorization), Boolean(item.xApiKey), Boolean(item.apiKey)]), [
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [false, false, false],
  ])

  seen.length = 0
  assert.equal(await probeModelEndpointAuthentication({
    baseUrl,
    apiKey: "",
    authType: "auto",
    model: "chat-model",
  }), "none")
  assert.deepEqual(seen, [{ authorization: undefined, xApiKey: undefined, apiKey: undefined }])

  mode = "upstream-error"
  seen.length = 0
  await assert.rejects(
    probeModelEndpointAuthentication({
      baseUrl,
      apiKey: "synthetic-test-key",
      authType: "auto",
      model: "chat-model",
    }),
    error => error instanceof ModelEndpointError && error.code === "upstream_error",
  )
  assert.equal(seen.length, 1)
})
