import test from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { generateOpenAICompatibleImage, MediaGenerationError } from "../lib/llm/media-generation"
import { probeOpenAIChatDetailed } from "../lib/llm/chat-endpoint-probe"
import { ModelEndpointError } from "../lib/llm/openai-compatible"

test("media 404 errors preserve a redacted upstream reason", async () => {
  const apiKey = "opaque-media-credential"
  await assert.rejects(
    generateOpenAICompatibleImage({
      baseUrl: "https://media.example/v1",
      apiKey,
      authType: "bearer",
      model: "gpt-image-1",
      outputKind: "image",
      prompt: "square",
      fetcher: async () => Response.json(
        { error: { message: `model does not support image generation (${apiKey})` } },
        { status: 404 },
      ),
    }),
    (error: unknown) => error instanceof MediaGenerationError
      && error.code === "media_not_found"
      && error.message.includes("does not support image generation")
      && error.message.includes("***")
      && !error.message.includes(apiKey),
  )
})

test("chat 404 errors preserve a redacted upstream reason", { concurrency: false }, async t => {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previousNodeEnv = mutableEnv.NODE_ENV
  mutableEnv.NODE_ENV = "test"
  t.after(() => {
    if (previousNodeEnv === undefined) delete mutableEnv.NODE_ENV
    else mutableEnv.NODE_ENV = previousNodeEnv
  })

  const credential = "opaque-chat-credential"
  const server = createServer((_request, response) => {
    response.writeHead(404, { "Content-Type": "application/json" })
    response.end(JSON.stringify({ error: { message: `model is unavailable (${credential})` } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address === "object")

  await assert.rejects(
    probeOpenAIChatDetailed({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: credential,
      authType: "bearer",
      model: "chat-model",
    }),
    (error: unknown) => error instanceof ModelEndpointError
      && error.code === "chat_not_found"
      && error.message.includes("model is unavailable")
      && error.message.includes("***")
      && !error.message.includes(credential),
  )
})
