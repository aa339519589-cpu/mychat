import test from "node:test"
import assert from "node:assert/strict"
import dns from "node:dns/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { once } from "node:events"
import {
  assertExclusiveStoredEndpointReference,
  classifyModelEndpointAddress,
  discoverOpenAIModels,
  endpointAuthHeaders,
  ModelEndpointError,
  modelListUrlCandidates,
  normalizeOpenAIBaseUrl,
  probeOpenAIChat,
  resolveEndpointPatchApiKey,
  safeModelEndpointFetch,
  validateModelEndpointNetwork,
} from "../lib/llm/openai-compatible"
import { buildProviderRequest } from "../lib/llm/provider-adapters"
import { runAgentLoop } from "../lib/llm/agent-loop"
import { upstreamError } from "../lib/llm/stream"
import { isSafeModelId, modelDisplayName } from "../lib/model-endpoints"
import {
  isEncryptedModelEndpointKey,
  openModelEndpointKey,
  sealModelEndpointKey,
} from "../lib/model-endpoint-secret"
import { resolveMediaEndpointConnection } from "../lib/model-endpoint-server"

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

test("normalizes common OpenAI-compatible base URL forms", () => {
  assert.equal(normalizeOpenAIBaseUrl("https://api.example.com/"), "https://api.example.com")
  assert.equal(normalizeOpenAIBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1")
  assert.equal(normalizeOpenAIBaseUrl("https://api.example.com/v1/models"), "https://api.example.com/v1")
  assert.equal(normalizeOpenAIBaseUrl("https://api.example.com/v1/chat/completions"), "https://api.example.com/v1")
  assert.deepEqual(modelListUrlCandidates("https://api.example.com/v1"), ["https://api.example.com/v1/models"])
  assert.deepEqual(modelListUrlCandidates("https://api.example.com/gateway"), [
    "https://api.example.com/gateway/models",
    "https://api.example.com/gateway/v1/models",
  ])
})

test("builds only allowlisted API key headers", () => {
  assert.deepEqual(endpointAuthHeaders("secret", "bearer"), { Authorization: "Bearer secret" })
  assert.deepEqual(endpointAuthHeaders("secret", "x-api-key"), { "x-api-key": "secret" })
  assert.deepEqual(endpointAuthHeaders("secret", "api-key"), { "api-key": "secret" })
  assert.deepEqual(endpointAuthHeaders("secret", "none"), {})
})

test("stored endpoint requests cannot override routing fields or reuse a key after a base URL change", () => {
  assert.doesNotThrow(() => assertExclusiveStoredEndpointReference({ endpointId: "endpoint-a" }))
  for (const field of ["baseUrl", "apiKey", "authType", "protocol", "model", "modelId", "futureField"]) {
    assert.throws(
      () => assertExclusiveStoredEndpointReference({ endpointId: "endpoint-a", [field]: "override" }),
      (error: unknown) => error instanceof ModelEndpointError && error.code === "stored_endpoint_override",
      field,
    )
  }

  let storedKeyReads = 0
  const readStored = () => {
    storedKeyReads++
    return "synthetic-stored-credential"
  }
  assert.throws(
    () => resolveEndpointPatchApiKey({}, "https://old.example/v1", "https://new.example/v1", readStored),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "new_api_key_required",
  )
  assert.equal(storedKeyReads, 0)
  assert.equal(
    resolveEndpointPatchApiKey({ apiKey: "" }, "https://old.example/v1", "https://new.example/v1", readStored),
    "",
  )
  assert.equal(storedKeyReads, 0)
  assert.equal(
    resolveEndpointPatchApiKey({}, "https://same.example/v1", "https://same.example/v1", readStored),
    "synthetic-stored-credential",
  )
  assert.equal(storedKeyReads, 1)
})

test("classifies IPv4-mapped IPv6 and blocks protected networks in the right environments", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  const previousAllowlist = mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
    if (previousAllowlist === undefined) delete mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST
    else mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST = previousAllowlist
  })
  delete mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST

  assert.equal(classifyModelEndpointAddress("::ffff:7f00:1"), "private")
  assert.equal(classifyModelEndpointAddress("::ffff:127.0.0.1"), "private")
  assert.equal(classifyModelEndpointAddress("0:0:0:0:0:ffff:7f00:1"), "private")
  assert.equal(classifyModelEndpointAddress("::FFFF:a00:1"), "private")
  assert.equal(classifyModelEndpointAddress("::ffff:ac10:1"), "private")
  assert.equal(classifyModelEndpointAddress("::ffff:c0a8:101"), "private")
  assert.equal(classifyModelEndpointAddress("::ffff:a9fe:a9fe"), "blocked")
  assert.equal(classifyModelEndpointAddress("::ffff:169.254.169.254"), "blocked")
  assert.equal(classifyModelEndpointAddress("::ffff:808:808"), "public")
  assert.equal(classifyModelEndpointAddress("64:ff9b::7f00:1"), "private")
  assert.equal(classifyModelEndpointAddress("64:ff9b::192.168.1.1"), "private")
  assert.equal(classifyModelEndpointAddress("64:ff9b::a9fe:a9fe"), "blocked")
  assert.equal(classifyModelEndpointAddress("64:ff9b::169.254.169.254"), "blocked")
  assert.equal(classifyModelEndpointAddress("64:ff9b::808:808"), "public")
  assert.equal(classifyModelEndpointAddress("::7f00:1"), "private")
  assert.equal(classifyModelEndpointAddress("::a9fe:a9fe"), "blocked")
  assert.equal(classifyModelEndpointAddress("::808:808"), "public")
  assert.equal(classifyModelEndpointAddress("::ffff:0:7f00:1"), "private")
  assert.equal(classifyModelEndpointAddress("::ffff:0:a9fe:a9fe"), "blocked")
  assert.equal(classifyModelEndpointAddress("::ffff:0:808:808"), "public")
  assert.equal(classifyModelEndpointAddress("2002:7f00:1::"), "private")
  assert.equal(classifyModelEndpointAddress("2002:a9fe:a9fe::"), "blocked")
  assert.equal(classifyModelEndpointAddress("2002:808:808::"), "public")
  assert.equal(classifyModelEndpointAddress("2001:0000:4136:e378:8000:63bf:3fff:fdd2"), "blocked")

  mutableEnv.NODE_ENV = "test"
  await assert.rejects(
    validateModelEndpointNetwork("http://[::ffff:a9fe:a9fe]/v1"),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "blocked_address" && error.status === 403,
  )
  mutableEnv.NODE_ENV = "production"
  mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST = "64:ff9b::a9fe:a9fe"
  await assert.rejects(
    validateModelEndpointNetwork("http://[64:ff9b::a9fe:a9fe]/v1"),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "blocked_address" && error.status === 403,
  )
  mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST = "::ffff:a9fe:a9fe"
  await assert.rejects(
    validateModelEndpointNetwork("http://[::ffff:a9fe:a9fe]/v1"),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "blocked_address" && error.status === 403,
  )
  delete mutableEnv.MODEL_ENDPOINT_PRIVATE_ALLOWLIST
  await assert.rejects(
    validateModelEndpointNetwork("http://[::ffff:7f00:1]/v1"),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "private_url" && error.status === 403,
  )
})

test("pins the socket to the validated DNS answer while preserving the original Host", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  const originalLookup = dns.lookup
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    dns.lookup = originalLookup
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  let receivedHost = ""
  const server = createServer((request, response) => {
    receivedHost = request.headers.host ?? ""
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ ok: true }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")

  let lookups = 0
  dns.lookup = (async () => {
    lookups++
    return lookups === 1
      ? [{ address: "127.0.0.1", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }]
  }) as unknown as typeof dns.lookup

  const response = await safeModelEndpointFetch(`http://rebind.invalid:${address.port}/models`, {
    redirect: "manual",
    signal: AbortSignal.timeout(2_000),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(lookups, 1)
  assert.equal(receivedHost, `rebind.invalid:${address.port}`)
})

test("production refuses to send endpoint credentials over public HTTP", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  const originalLookup = dns.lookup
  mutableEnv.NODE_ENV = "production"
  dns.lookup = (async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof dns.lookup
  t.after(() => {
    dns.lookup = originalLookup
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  await assert.rejects(
    safeModelEndpointFetch("http://public-http.invalid/models", {
      headers: { Authorization: "Bearer endpoint-key" },
    }),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "insecure_http",
  )
})

test("rejects an invalid upstream HTTP status without crashing the process", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const server = createServer((_request, response) => {
    response.writeHead(700)
    response.end("invalid")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")

  await assert.rejects(
    safeModelEndpointFetch(`http://127.0.0.1:${address.port}/models`),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "invalid_status" && error.status === 502,
  )
})

test("manual media endpoints remain configurable when the service has no model list", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ error: { message: "no model list" } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}/gateway`

  assert.deepEqual(
    await resolveMediaEndpointConnection({ baseUrl, apiKey: "key", authType: "auto" }),
    { baseUrl, authType: "bearer" },
  )
  assert.deepEqual(
    await resolveMediaEndpointConnection({ baseUrl, apiKey: "key", authType: "x-api-key" }),
    { baseUrl, authType: "x-api-key" },
  )
})

test("media endpoint setup preserves model-list authentication and upstream failures", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const server = createServer((request, response) => {
    const status = request.url?.startsWith("/unauthorized/") ? 401 : 500
    response.writeHead(status, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ error: { message: status === 401 ? "bad key" : "broken upstream" } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")

  await assert.rejects(
    resolveMediaEndpointConnection({
      baseUrl: `http://127.0.0.1:${address.port}/unauthorized`,
      apiKey: "wrong",
      authType: "bearer",
    }),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "auth_failed",
  )
  await assert.rejects(
    resolveMediaEndpointConnection({
      baseUrl: `http://127.0.0.1:${address.port}/broken`,
      apiKey: "key",
      authType: "bearer",
    }),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "upstream_error",
  )
})

test("rejects credentials and URLs where a model ID is expected", () => {
  assert.equal(isSafeModelId("openai/gpt-5-mini"), true)
  assert.equal(isSafeModelId("sk-this-is-not-a-model"), false)
  assert.equal(isSafeModelId("opaque-provider-credential", "opaque-provider-credential"), false)
  assert.equal(modelDisplayName("safe-model", "opaque-provider-credential", "opaque-provider-credential"), "safe-model")
  assert.equal(isSafeModelId("https://api.example.com/v1"), false)
  assert.doesNotMatch(upstreamError(500, JSON.stringify({ error: { message: "bad sk-secret-value-123456" } })), /sk-secret/)
})

test("model discovery skips incompatible root responses and filters the exact API key", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const key = "opaque-provider-credential"
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? "")
    response.writeHead(200, { "Content-Type": "application/json" })
    if (request.url === "/gateway/models") {
      response.end(JSON.stringify({ gateway: true }))
      return
    }
    response.end(JSON.stringify({ data: [
      { id: key },
      { id: "safe-model", display_name: key },
    ] }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")

  const result = await discoverOpenAIModels({
    baseUrl: `http://127.0.0.1:${address.port}/gateway`,
    apiKey: key,
    authType: "bearer",
  })
  assert.deepEqual(requests, ["/gateway/models", "/gateway/v1/models"])
  assert.equal(result.baseUrl, `http://127.0.0.1:${address.port}/gateway/v1`)
  assert.deepEqual(result.models.map(model => ({ id: model.id, displayName: model.displayName })), [
    { id: "safe-model", displayName: "safe-model" },
  ])
})

test("generic provider omits vendor-specific request fields", () => {
  const request = buildProviderRequest("generic-openai", {
    model: "custom-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    thinking: true,
    apiKey: "secret",
    authType: "x-api-key",
  })
  assert.equal(request.body.model, "custom-model")
  assert.equal(request.body.stream, true)
  assert.equal(request.body.thinking, undefined)
  assert.equal(request.body.stream_options, undefined)
  assert.equal(request.body.max_tokens, undefined)
  assert.equal(request.body.max_completion_tokens, undefined)
  assert.equal(request.headers["x-api-key"], "secret")
  assert.equal(request.headers.Authorization, undefined)
})

test("endpoint secrets are encrypted and bound to user and endpoint", { concurrency: false }, t => {
  const previous = process.env.AGENT_CREDENTIAL_KEY
  process.env.AGENT_CREDENTIAL_KEY = "test-model-endpoint-secret-that-is-at-least-32-characters"
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CREDENTIAL_KEY
    else process.env.AGENT_CREDENTIAL_KEY = previous
  })

  const sealed = sealModelEndpointKey("test-api-key", "user-a", "endpoint-a")
  assert.equal(isEncryptedModelEndpointKey(sealed), true)
  assert.doesNotMatch(sealed, /test-api-key/)
  assert.equal(openModelEndpointKey(sealed, "user-a", "endpoint-a"), "test-api-key")
  assert.equal(openModelEndpointKey(sealed, "user-b", "endpoint-a"), null)
  assert.equal(openModelEndpointKey(sealed, "user-a", "endpoint-b"), null)
  assert.equal(openModelEndpointKey("legacy-plaintext", "user-a", "endpoint-a"), null)
})

test("generic agent loop retries plain chat when tools are unsupported", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const bodies: any[] = []
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    if (body.tools) return Response.json({ error: { message: "tools unsupported" } }, { status: 400 })
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: "fallback-ok" } }] })
  }
  let output = ""
  const result = await runAgentLoop({
    url: "https://example.com/v1/chat/completions",
    apiKey: "key",
    model: "custom-model",
    adapter: "generic-openai",
    thinking: false,
    messages: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", function: { name: "memory", parameters: {} } }],
    emit: event => { if ("text" in event) output += event.text },
    executeTool: async () => "unused",
    maxRounds: 2,
    turnOptions: { fetcher: globalThis.fetch },
  })
  assert.equal(result.totalTokens, 0)
  assert.equal(output, "fallback-ok")
  assert.equal(bodies.length, 2)
  assert.ok(Array.isArray(bodies[0].tools))
  assert.equal(bodies[1].tools, undefined)
})

test("discovers models and verifies the real streaming chat path", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const requests: { method?: string; url?: string; auth?: string; body?: any }[] = []
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/gateway/models") {
      response.writeHead(404, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "not found" } }))
      return
    }
    if (request.method === "GET" && request.url === "/gateway/v1/models") {
      requests.push({ method: request.method, url: request.url, auth: request.headers.authorization })
      if (request.headers.authorization !== "Bearer test-key") {
        response.writeHead(401, { "Content-Type": "application/json" })
        response.end(JSON.stringify({ error: { message: "bad key" } }))
        return
      }
      response.writeHead(200, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ data: [
        { id: "chat-model", display_name: "Chat Model", owned_by: "local" },
        { id: "image-model" },
        { id: "chat-model" },
      ] }))
      return
    }
    if (request.method === "POST" && request.url === "/gateway/v1/chat/completions") {
      const body = JSON.parse(await requestBody(request))
      requests.push({ method: request.method, url: request.url, auth: request.headers.authorization, body })
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "O" }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "K" }, finish_reason: "stop" }] })}\n\n`)
      response.end("data: [DONE]\n\n")
      return
    }
    response.writeHead(404).end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}/gateway`

  const discovered = await discoverOpenAIModels({ baseUrl, apiKey: "test-key", authType: "auto" })
  assert.equal(discovered.baseUrl, `${baseUrl}/v1`)
  assert.equal(discovered.authType, "bearer")
  assert.deepEqual(discovered.models.map(model => [model.id, model.chatCompatible]), [
    ["chat-model", true],
    ["image-model", false],
  ])

  const probe = await probeOpenAIChat({ baseUrl: discovered.baseUrl, apiKey: "test-key", authType: "bearer", model: "chat-model" })
  assert.equal(probe.content, "OK")
  const chatRequest = requests.find(request => request.method === "POST")
  assert.equal(chatRequest?.auth, "Bearer test-key")
  assert.equal(chatRequest?.body.model, "chat-model")
  assert.equal(chatRequest?.body.stream, true)
  assert.equal(chatRequest?.body.thinking, undefined)
  assert.equal(chatRequest?.body.stream_options, undefined)
  assert.equal(chatRequest?.body.tools, undefined)
})

test("automatic model discovery falls back to no auth only after authentication failures", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const authHeaders: boolean[] = []
  let mode: "no-auth" | "upstream-error" = "no-auth"
  const server = createServer((request, response) => {
    const hasAuth = Boolean(request.headers.authorization || request.headers["x-api-key"] || request.headers["api-key"])
    authHeaders.push(hasAuth)
    if (mode === "upstream-error") {
      response.writeHead(500, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "provider unavailable" } }))
      return
    }
    if (hasAuth) {
      response.writeHead(401, { "Content-Type": "application/json" })
      response.end(JSON.stringify({ error: { message: "unexpected authentication" } }))
      return
    }
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ data: [{ id: "chat-model" }] }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}/v1`

  const discovered = await discoverOpenAIModels({
    baseUrl,
    apiKey: "synthetic-test-credential",
    authType: "auto",
  })
  assert.equal(discovered.authType, "none")
  assert.deepEqual(authHeaders, [true, true, true, false])

  mode = "upstream-error"
  authHeaders.length = 0
  await assert.rejects(
    discoverOpenAIModels({ baseUrl, apiKey: "synthetic-test-credential", authType: "auto" }),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "upstream_error",
  )
  assert.deepEqual(authHeaders, [true])
})

test("redacts the exact API key from discovery and probe errors", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const credential = "opaque-test-credential"
  const server = createServer((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ error: { message: `upstream echoed ${credential}` } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}`

  await assert.rejects(
    discoverOpenAIModels({ baseUrl, apiKey: credential, authType: "bearer" }),
    (error: unknown) => error instanceof ModelEndpointError
      && !error.message.includes(credential)
      && error.message.includes("***"),
  )
  await assert.rejects(
    probeOpenAIChat({ baseUrl, apiKey: credential, authType: "bearer", model: "chat-model" }),
    (error: unknown) => error instanceof ModelEndpointError
      && !error.message.includes(credential)
      && error.message.includes("***"),
  )
})
