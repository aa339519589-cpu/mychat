import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { resolveEndpointCreationConnection } from "../lib/model-endpoint-creation"
import { ModelEndpointError } from "../lib/llm/openai-compatible"
import { openModelEndpointKey, sealModelEndpointKey } from "../lib/model-endpoint-secret"
import type { ModelEndpointRow } from "../lib/model-endpoint-server"

const sourceId = "12345678-1234-4321-abcd-123456789abc"
const userId = "owner"
const context = {
  userId, endpointId: sourceId, baseUrl: "https://gateway.example/v1", protocol: "openai",
  authType: "bearer", model: "claude-sonnet-5-5", outputKind: "chat",
}
const request = { sourceEndpointId: sourceId, model: "claude-haiku-4-5", outputKind: "chat" }

test("a stored connection rejects credential or destination overrides before lookup", async () => {
  for (const field of ["baseUrl", "apiKey", "authType", "protocol", "endpointId", "futureField"]) {
    await assert.rejects(resolveEndpointCreationConnection({ ...request, [field]: "override" }, userId,
      async () => { throw new Error("Must reject before loading a key") }),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "stored_endpoint_override")
  }
})

test("stored connection lookup validates the reference and ownership", async () => {
  await assert.rejects(resolveEndpointCreationConnection({ ...request, sourceEndpointId: "bad" }, userId,
    async () => { throw new Error("Must reject before lookup") }),
  (error: unknown) => error instanceof ModelEndpointError && error.status === 400)
  await assert.rejects(resolveEndpointCreationConnection(request, userId, async () => null),
    (error: unknown) => error instanceof ModelEndpointError && error.status === 404)
  const foreign = { id: sourceId, user_id: "other-owner" } as ModelEndpointRow
  await assert.rejects(resolveEndpointCreationConnection(request, userId, async () => foreign),
    (error: unknown) => error instanceof ModelEndpointError && error.status === 404)
})

test("adding a model reuses only its owner's key and reseals it for the new model", { concurrency: false }, async t => {
  const previous = process.env.AGENT_CREDENTIAL_KEY
  process.env.AGENT_CREDENTIAL_KEY = randomBytes(32).toString("hex")
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CREDENTIAL_KEY
    else process.env.AGENT_CREDENTIAL_KEY = previous
  })
  const source: ModelEndpointRow = {
    id: sourceId, user_id: userId, name: "Sonnet", protocol: context.protocol,
    base_url: context.baseUrl, model: context.model, output_kind: context.outputKind,
    auth_type: context.authType, api_key: sealModelEndpointKey("synthetic-provider-key", context),
  }
  const resolved = await resolveEndpointCreationConnection(request, userId, async () => source)
  assert.deepEqual(resolved, { baseUrl: context.baseUrl, apiKey: "synthetic-provider-key", authType: "bearer" })
  const nextContext = { ...context, endpointId: "new-model-endpoint", model: request.model }
  const sealed = sealModelEndpointKey(resolved.apiKey, nextContext)
  assert.equal(openModelEndpointKey(sealed, nextContext), "synthetic-provider-key")
  assert.equal(openModelEndpointKey(sealed, context), null)
  assert.equal(openModelEndpointKey(source.api_key, context), "synthetic-provider-key")
  await assert.rejects(resolveEndpointCreationConnection({ ...request, outputKind: "image" }, userId, async () => source),
    (error: unknown) => error instanceof ModelEndpointError && error.code === "endpoint_output_mismatch")
})

test("explicit new connections preserve normal credential normalization", async () => {
  const resolved = await resolveEndpointCreationConnection({ baseUrl: "https://other.example/v1/", apiKey: " new-key ", authType: "bearer" }, userId,
    async () => { throw new Error("No stored connection should be loaded") })
  assert.deepEqual(resolved, { baseUrl: "https://other.example/v1", apiKey: "new-key", authType: "bearer" })
})
