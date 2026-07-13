import test from "node:test"
import assert from "node:assert/strict"

import { conversationIdFromPath, conversationPath } from "../components/literary-chat/use-conversation-route"

test("conversation routes encode and decode identifiers", () => {
  const id = "thread/一"
  assert.equal(conversationPath(id), "/c/thread%2F%E4%B8%80")
  assert.equal(conversationIdFromPath(conversationPath(id)), id)
})

test("conversation routes reject unrelated and malformed paths", () => {
  assert.equal(conversationIdFromPath("/"), null)
  assert.equal(conversationIdFromPath("/settings"), null)
  assert.equal(conversationIdFromPath("/c/%E0%A4%A"), null)
  assert.equal(conversationPath(null), "/")
})
