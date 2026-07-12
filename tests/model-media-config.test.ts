import test from "node:test"
import assert from "node:assert/strict"
import {
  resolveDeepTierImageConfig,
  resolveDeepTierVideoConfig,
} from "../lib/llm/models"

const MEDIA_ENV_KEYS = [
  "DEEP_TIER_BASE_URL",
  "DEEP_TIER_API_KEY",
  "DEEP_TIER_AUTH_TYPE",
  "DEEP_TIER_IMAGE_BASE_URL",
  "DEEP_TIER_IMAGE_API_KEY",
  "DEEP_TIER_IMAGE_AUTH_TYPE",
  "DEEP_TIER_IMAGE_MODEL",
  "DEEP_TIER_VIDEO_BASE_URL",
  "DEEP_TIER_VIDEO_API_KEY",
  "DEEP_TIER_VIDEO_AUTH_TYPE",
  "DEEP_TIER_VIDEO_MODEL",
] as const

test("platform media endpoints can be configured independently from the deep-tier proxy", { concurrency: false }, async t => {
  const env = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(MEDIA_ENV_KEYS.map(key => [key, env[key]]))

  for (const key of MEDIA_ENV_KEYS) delete env[key]
  t.after(() => {
    for (const key of MEDIA_ENV_KEYS) {
      const value = previous[key]
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  })

  await t.test("image-specific transport overrides an expired shared endpoint", () => {
    env.DEEP_TIER_BASE_URL = "https://temporary-tunnel.example/v1"
    env.DEEP_TIER_API_KEY = "shared-key"
    env.DEEP_TIER_AUTH_TYPE = "bearer"
    env.DEEP_TIER_IMAGE_BASE_URL = "https://stable-media.example/v1"
    env.DEEP_TIER_IMAGE_API_KEY = "image-key"
    env.DEEP_TIER_IMAGE_AUTH_TYPE = "x-api-key"
    env.DEEP_TIER_IMAGE_MODEL = "image-model"

    assert.deepEqual(resolveDeepTierImageConfig(), {
      baseUrl: "https://stable-media.example/v1",
      apiKey: "image-key",
      authType: "x-api-key",
      model: "image-model",
    })
  })

  await t.test("video keeps backward-compatible fallback to shared deep-tier settings", () => {
    delete env.DEEP_TIER_VIDEO_BASE_URL
    delete env.DEEP_TIER_VIDEO_API_KEY
    delete env.DEEP_TIER_VIDEO_AUTH_TYPE
    env.DEEP_TIER_VIDEO_MODEL = "video-model"

    assert.deepEqual(resolveDeepTierVideoConfig(), {
      baseUrl: "https://temporary-tunnel.example/v1",
      apiKey: "shared-key",
      authType: "bearer",
      model: "video-model",
    })
  })

  await t.test("an explicitly unauthenticated media endpoint does not require a key", () => {
    env.DEEP_TIER_IMAGE_BASE_URL = "https://public-media.example/v1"
    env.DEEP_TIER_IMAGE_API_KEY = ""
    env.DEEP_TIER_IMAGE_AUTH_TYPE = "none"
    delete env.DEEP_TIER_API_KEY

    assert.deepEqual(resolveDeepTierImageConfig(), {
      baseUrl: "https://public-media.example/v1",
      apiKey: "",
      authType: "none",
      model: "image-model",
    })
  })
})
