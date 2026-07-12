import assert from 'node:assert/strict'
import test from 'node:test'
import { isPlatformMediaTier, MODEL_SHEET_TIERS, TIER_MAP } from '../lib/chat-data'

test('model sheet order ends with image and video', () => {
  assert.deepEqual(MODEL_SHEET_TIERS, ["鸿篇", "正构", "绝句", "绘影", "录像"])
  assert.equal(TIER_MAP["绘影"].label, "图片")
  assert.equal(TIER_MAP["录像"].label, "视频")
  assert.equal(TIER_MAP["绘影"].media, "image")
  assert.equal(TIER_MAP["录像"].media, "video")
  assert.equal(isPlatformMediaTier("绘影"), true)
  assert.equal(isPlatformMediaTier("鸿篇"), false)
})
