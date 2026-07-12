import test from "node:test"
import assert from "node:assert/strict"
import {
  networkError,
  upstreamError,
  userFacingUpstreamErrorMessage,
} from "../lib/llm/stream"

test("turns ngrok offline responses into an actionable deployment message", () => {
  const raw = "媒体生成请求返回 404: The endpoint apple-waviness-chowder.ngrok-free.dev is offline. ERR_NGROK_3200"
  const message = userFacingUpstreamErrorMessage(raw)

  assert.match(message, /ngrok 反代隧道已离线/)
  assert.match(message, /ERR_NGROK_3200/)
  assert.match(message, /DEEP_TIER_\*_BASE_URL/)
  assert.doesNotMatch(message, /apple-waviness-chowder/)
})

test("applies ngrok diagnosis to HTTP and network error formatters", () => {
  const raw = JSON.stringify({
    error: {
      message: "The endpoint old-tunnel.ngrok-free.dev is offline. ERR_NGROK_3200",
    },
  })

  assert.match(upstreamError(404, raw, "媒体生成服务"), /反代隧道已离线/)
  assert.match(
    networkError(new Error("The endpoint old-tunnel.ngrok-free.dev is offline. ERR_NGROK_3200"), "媒体生成服务"),
    /反代隧道已离线/,
  )
})

test("leaves unrelated upstream messages unchanged", () => {
  const message = "媒体生成请求返回 403：permission denied"
  assert.equal(userFacingUpstreamErrorMessage(message), message)
})
