import test from "node:test"
import assert from "node:assert/strict"
import { isKnownTextOnlyModel, modelOutputKind } from "../lib/model-endpoints"
import { resolveModelEndpointKey, type ModelEndpointRow } from "../lib/model-endpoint-server"

test("classifies Volcengine Seedream and Seedance model families", () => {
  for (const model of [
    "doubao-seedream-4-0",
    "doubao-seedream-4-5-250528",
    "seedream-5-0-lite",
    "seededit-3-0",
  ]) {
    assert.equal(modelOutputKind(model), "image", model)
  }

  for (const model of [
    "doubao-seedance-1-0-pro",
    "doubao-seedance-1-5-pro-251215",
    "seedance-2-0-fast",
  ]) {
    assert.equal(modelOutputKind(model), "video", model)
  }
})

test("identifies known text-only models without blocking unknown media overrides", () => {
  assert.equal(isKnownTextOnlyModel("doubao-pro-4k-functioncall-240515"), true)
  assert.equal(isKnownTextOnlyModel("doubao-lite-128k-240428"), true)
  assert.equal(isKnownTextOnlyModel("doubao-embedding-text-240715"), true)
  assert.equal(isKnownTextOnlyModel("mistral-7b-instruct-v0.2"), true)
  assert.equal(isKnownTextOnlyModel("doubao-seedream-4-5-250528"), false)
  assert.equal(isKnownTextOnlyModel("doubao-seedance-1-5-pro-251215"), false)
  assert.equal(isKnownTextOnlyModel("custom-canvas-v2"), false)
})

test("legacy text models saved as media fail before credential decryption or generation", () => {
  const row: ModelEndpointRow = {
    id: "endpoint-test",
    user_id: "user-test",
    name: "Wrong media model",
    protocol: "openai",
    base_url: "https://ark.cn-beijing.volces.com/api/v3",
    api_key: "legacy-or-unreadable-value",
    model: "doubao-pro-4k-functioncall-240515",
    output_kind: "image",
    auth_type: "bearer",
  }

  assert.throws(
    () => resolveModelEndpointKey(row, "user-test"),
    /重新选择 Seedream 或 Seedance/,
  )
})
