import test from "node:test"
import assert from "node:assert/strict"
import {
  controlledGeneratedMediaUrl,
  generatedMediaObjectKey,
  hasInlineGeneratedMedia,
  isPrivateNetworkGeneratedMediaUrl,
  isSafeGeneratedMediaUrl,
  normalizeGeneratedMedia,
  normalizeGeneratedMediaList,
} from "../lib/generated-media"

const objectKey = '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/20000000-0000-4000-8000-000000000001/asset.png'

test("generated media accepts supported image and video sources", () => {
  assert.equal(isSafeGeneratedMediaUrl("image", "https://cdn.example/image.png"), true)
  assert.equal(isSafeGeneratedMediaUrl("image", "data:image/png;base64,cG5n"), true)
  assert.equal(isSafeGeneratedMediaUrl("video", "data:video/mp4;base64,AAECAw=="), true)
  assert.deepEqual(normalizeGeneratedMedia({ type: "video", url: "https://cdn.example/video.mp4", mimeType: "video/mp4" }), {
    type: "video",
    url: "https://cdn.example/video.mp4",
    mimeType: "video/mp4",
  })
})

test("generated media rejects executable and unsupported data URLs", () => {
  assert.equal(normalizeGeneratedMedia({ type: "image", url: "javascript:alert(1)" }), null)
  assert.equal(normalizeGeneratedMedia({ type: "image", url: "data:image/svg+xml;base64,PHN2Zz4=" }), null)
  assert.equal(normalizeGeneratedMedia({ type: "video", url: "data:text/html;base64,PGgxPkJhZDwvaDE+" }), null)
})

test('legacy Storage references normalize to the authenticated same-origin proxy', () => {
  const controlled = controlledGeneratedMediaUrl(objectKey)
  const legacy = `https://project.supabase.co/storage/v1/object/public/generated-media/${objectKey}`
  assert.equal(generatedMediaObjectKey(controlled), objectKey)
  assert.equal(generatedMediaObjectKey(legacy), objectKey)
  assert.equal(isSafeGeneratedMediaUrl('image', controlled), true)
  assert.deepEqual(normalizeGeneratedMedia({ type: 'image', url: legacy }), {
    type: 'image',
    url: controlled,
  })
  assert.equal(generatedMediaObjectKey(`${controlled}?token=leak`), null)
  assert.equal(generatedMediaObjectKey('/api/v1/media/../../secret/content'), null)
  assert.equal(controlledGeneratedMediaUrl(objectKey, 'https://chat.example/base'),
    `https://chat.example${controlled}`)
})

test("generated media blocks browser requests to local and private networks", () => {
  const blocked = [
    "http://localhost/image.png",
    "https://chat.local/image.png",
    "http://127.42.0.1/image.png",
    "http://10.0.0.8/image.png",
    "http://172.31.2.3/image.png",
    "http://192.168.50.68/image.png",
    "http://169.254.169.254/image.png",
    "http://168.63.129.16/image.png",
    "http://[::1]/image.png",
    "http://[fe80::1]/image.png",
    "http://[fd12::1]/image.png",
    "http://[::ffff:127.0.0.1]/image.png",
    "http://[::ffff:0:7f00:1]/image.png",
    "http://[::7f00:1]/image.png",
    "http://[64:ff9b::c0a8:544]/image.png",
    "http://[64:ff9b:1::c0a8:101]/image.png",
    "http://[100::1]/image.png",
    "http://[2001:2::1]/image.png",
    "http://[2001:db8::1]/image.png",
    "http://[ff02::1]/image.png",
    "http://[2002:7f00:1::]/image.png",
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/image.png",
  ]
  for (const url of blocked) {
    assert.equal(isPrivateNetworkGeneratedMediaUrl(url), true, url)
    assert.equal(isSafeGeneratedMediaUrl("image", url), false, url)
  }
  assert.equal(isSafeGeneratedMediaUrl("image", "https://cdn.example/image.png"), true)
  assert.equal(isSafeGeneratedMediaUrl("image", "https://[64:ff9b::808:808]/image.png"), true)
  assert.equal(isSafeGeneratedMediaUrl("image", "https://[::808:808]/image.png"), true)
  assert.equal(isSafeGeneratedMediaUrl("image", "https://[2002:808:808::]/image.png"), true)

  // Normalization retains the result so the renderer can show a safety error
  // instead of silently dropping the model output.
  assert.deepEqual(normalizeGeneratedMedia({ type: "image", url: blocked[0] }), {
    type: "image",
    url: blocked[0],
  })
})

test("inline generated media opts a conversation out of localStorage caching", () => {
  assert.equal(hasInlineGeneratedMedia([{ type: "image", url: "data:image/png;base64,cG5n" }]), true)
  assert.equal(hasInlineGeneratedMedia([{ type: "image", url: "DATA:image/png;base64,cG5n" }]), true)
  assert.equal(hasInlineGeneratedMedia([{ type: "video", url: "https://cdn.example/video.mp4" }]), false)
  assert.equal(hasInlineGeneratedMedia(undefined), false)
})

test("generated media lists deduplicate results and cap their count", () => {
  const items = Array.from({ length: 7 }, (_, index) => ({
    type: "image" as const,
    url: `https://cdn.example/${Math.min(index, 5)}.png`,
  }))
  items.push(items[0])
  const media = normalizeGeneratedMediaList(items)
  assert.equal(media.length, 4)
  assert.equal(new Set(media.map(item => item.url)).size, 4)
})
