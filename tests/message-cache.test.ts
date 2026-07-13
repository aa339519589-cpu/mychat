import assert from "node:assert/strict"
import test from "node:test"

import { normalizeCachedMessages } from "../lib/data/message-cache"

test("message cache normalization rejects malformed entries and preserves safe fields", () => {
  const messages = normalizeCachedMessages([
    null,
    { id: "bad-role", role: "system", content: "hidden" },
    {
      id: "m1",
      role: "assistant",
      content: "hello",
      time: "10:00",
      images: ["https://example.com/image.png", 42],
      memoryNotes: ["remember", false],
    },
  ])

  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, "m1")
  assert.equal(messages[0].role, "assistant")
  assert.equal(messages[0].content, "hello")
  assert.deepEqual(messages[0].images, ["https://example.com/image.png"])
  assert.deepEqual(messages[0].memoryNotes, ["remember"])
})
