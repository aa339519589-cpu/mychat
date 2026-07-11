import test from "node:test"
import assert from "node:assert/strict"
import {
  generateOpenAICompatibleImage,
  type ModelEndpointFetcher,
} from "../lib/llm/media-generation"

async function requestedSize(model: string): Promise<string> {
  let body: Record<string, unknown> | undefined
  const fetcher: ModelEndpointFetcher = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ data: [{ b64_json: "cG5n" }] })
  }

  await generateOpenAICompatibleImage({
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    authType: "none",
    model,
    outputKind: "image",
    prompt: "city",
    fetcher,
  })

  return String(body?.size ?? "")
}

test("uses a provider-safe image area for Seedream 5", async () => {
  assert.equal(await requestedSize("doubao-seedream-5-0-pro"), "2048x2048")
  assert.ok(2048 * 2048 >= 3_686_400)
})

test("keeps the legacy OpenAI-compatible size for other image models", async () => {
  assert.equal(await requestedSize("gpt-image-1"), "1024x1024")
})
