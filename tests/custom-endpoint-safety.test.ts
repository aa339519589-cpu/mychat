import test from "node:test"
import assert from "node:assert/strict"
import { networkError, upstreamError } from "../lib/llm/stream"

test("redacts the exact configured API key regardless of its prefix", () => {
  const apiKey = "AIza-non-openai-secret-value"
  const upstream = upstreamError(
    500,
    JSON.stringify({ error: { message: `credential rejected: ${apiKey}` } }),
    "模型服务",
    [apiKey],
  )
  const network = networkError(new Error(`connection failed for ${apiKey}`), "模型服务", [apiKey])

  assert.doesNotMatch(upstream, /AIza-non-openai-secret-value/)
  assert.doesNotMatch(network, /AIza-non-openai-secret-value/)
  assert.match(upstream, /API_KEY/)
  assert.match(network, /API_KEY/)
})
