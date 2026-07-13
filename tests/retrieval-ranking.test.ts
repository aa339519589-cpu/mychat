import assert from "node:assert/strict"
import test from "node:test"

import { dedupeHits, keywordScore, queryTerms, type RetrievalHit } from "../lib/llm/retrieval-ranking"

test("retrieval query terms normalize text and add Chinese intent synonyms", () => {
  const terms = queryTerms("今天中午吃什么？")
  assert.ok(terms.includes("今天中午吃什么"))
  assert.ok(terms.includes("午饭"))
  assert.ok(terms.includes("午餐"))
  assert.ok(keywordScore("午饭", "我们中午一起吃午饭") > 0)
})

test("retrieval hit deduplication keeps the highest-priority first occurrence", () => {
  const hit = (id: string, similarity: number): RetrievalHit => ({
    id,
    conversation_id: "conversation",
    conversation_title: null,
    project_id: null,
    message_start_id: "start",
    message_end_id: "end",
    content: id,
    similarity,
    created_at: null,
  })

  assert.deepEqual(dedupeHits([hit("first", 0.9), hit("duplicate", 0.5)]).map(item => item.id), ["first"])
})
