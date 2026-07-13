import assert from "node:assert/strict"
import test from "node:test"

import type { SupabaseServer } from "../lib/api/guard"
import { ensureConversationIndexed, retrieveHistoryContext } from "../lib/llm/active-retrieval"

const now = "2026-07-13T00:00:00.000Z"
const userId = "20000000-0000-4000-8000-000000000001"

function retrievalClient(projectId: string | null = null) {
  const indexedRows: unknown[] = []
  type Result = { data: unknown; error: null }

  class Query {
    private fields = ""
    private operation: "select" | "upsert" = "select"
    private payload: unknown = null
    private filters = new Map<string, unknown>()

    constructor(private readonly table: string) {}
    select(fields: string) { this.fields = fields; return this }
    upsert(payload: unknown) { this.operation = "upsert"; this.payload = payload; return this }
    eq(field: string, value: unknown) { this.filters.set(field, value); return this }
    is(field: string, value: unknown) { this.filters.set(field, value); return this }
    neq() { return this }
    in() { return this }
    order() { return this }
    limit() { return this }

    private result(): Result {
      if (this.table === "conversation_chunks") {
        if (this.operation === "upsert") {
          if (Array.isArray(this.payload)) indexedRows.push(...this.payload)
          return { data: null, error: null }
        }
        return { data: [], error: null }
      }
      if (this.table === "conversations") {
        if (this.fields === "id") return { data: [{ id: "history-conversation" }], error: null }
        if (this.filters.get("id") === "current-conversation") {
          return { data: { id: "current-conversation", title: "Current", project_id: projectId, updated_at: now }, error: null }
        }
        return { data: [{ id: "history-conversation", title: "History", project_id: projectId }], error: null }
      }
      if (this.filters.get("conversation_id") === "current-conversation") {
        return { data: [
          { id: "current-user", role: "user", content: "current question", created_at: now, conversation_id: "current-conversation" },
          { id: "current-answer", role: "assistant", content: "current answer", created_at: now, conversation_id: "current-conversation" },
        ], error: null }
      }
      if (this.filters.get("role") === "user") {
        return { data: [{ id: "history-user", role: "user", content: "用户喜欢咖啡和后端架构", created_at: now, conversation_id: "history-conversation" }], error: null }
      }
      return { data: [
        { id: "history-before", role: "assistant", content: "What do you like?", created_at: now, conversation_id: "history-conversation" },
        { id: "history-user", role: "user", content: "用户喜欢咖啡和后端架构", created_at: now, conversation_id: "history-conversation" },
        { id: "history-after", role: "assistant", content: "Noted", created_at: now, conversation_id: "history-conversation" },
      ], error: null }
    }

    maybeSingle() {
      const result = this.result()
      const data = Array.isArray(result.data) ? result.data[0] ?? null : result.data
      return Promise.resolve({ ...result, data })
    }
    then<TResult1 = Result, TResult2 = never>(
      onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(this.result()).then(onfulfilled, onrejected)
    }
  }

  const client = {
    from: (table: string) => new Query(table),
    rpc: async (name: string) => name === "match_conversation_chunks_text"
      ? { data: [{
          id: "chunk", conversation_id: "history-conversation", conversation_title: "History",
          project_id: projectId, message_start_id: "history-user", message_end_id: "history-user",
          content: "用户喜欢咖啡和后端架构", similarity: 0.7, created_at: now,
        }], error: null }
      : { data: [], error: null },
  } as unknown as SupabaseServer
  return { client, indexedRows }
}

test("active retrieval indexes new chunks and injects only user-anchored scoped history", { concurrency: false }, async t => {
  const previousEmbedding = process.env.EMBEDDING_API_KEY
  const previousOpenAi = process.env.OPENAI_API_KEY
  delete process.env.EMBEDDING_API_KEY
  delete process.env.OPENAI_API_KEY
  t.after(() => {
    if (previousEmbedding === undefined) delete process.env.EMBEDDING_API_KEY
    else process.env.EMBEDDING_API_KEY = previousEmbedding
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAi
  })

  const { client, indexedRows } = retrievalClient()
  await ensureConversationIndexed(client, userId, "current-conversation")
  assert.equal(indexedRows.length, 1)
  const light = await retrieveHistoryContext({ supabase: client, userId, conversationId: "current-conversation", query: "咖啡 后端架构", mode: "light" })
  assert.match(light, /主动检索到的历史对话片段/)
  assert.match(light, /【用户】用户喜欢咖啡和后端架构/)
  assert.doesNotMatch(light, /current question/)
  const balanced = await retrieveHistoryContext({ supabase: client, userId, conversationId: "current-conversation", query: "咖啡 后端架构", mode: "balanced" })
  assert.match(balanced, /History/)
  assert.match(balanced, /用户锚点/)
})

test("active retrieval treats missing identity and unavailable storage as empty context", async () => {
  await ensureConversationIndexed(null, null, null)
  assert.equal(await retrieveHistoryContext({ supabase: null, userId: null, conversationId: null, query: "", mode: "light" }), "")
  const broken = { from() { throw new Error("database unavailable") } } as unknown as SupabaseServer
  await ensureConversationIndexed(broken, userId, "conversation")
  assert.equal(await retrieveHistoryContext({ supabase: broken, userId, conversationId: "conversation", query: "history", mode: "balanced" }), "")
})

test("active retrieval short-circuits each missing boundary independently", async () => {
  const { client } = retrievalClient()
  await ensureConversationIndexed(null, userId, "conversation")
  await ensureConversationIndexed(client, null, "conversation")
  await ensureConversationIndexed(client, userId, null)
  assert.equal(await retrieveHistoryContext({
    supabase: null, userId, conversationId: null, query: "history", mode: "light",
  }), "")
  assert.equal(await retrieveHistoryContext({
    supabase: client, userId: null, conversationId: null, query: "history", mode: "light",
  }), "")
  assert.equal(await retrieveHistoryContext({
    supabase: client, userId, conversationId: null, query: "   ", mode: "light",
  }), "")
})

test("active retrieval keeps Project history isolated and defaults unknown modes", async () => {
  const projectId = "30000000-0000-4000-8000-000000000001"
  const { client } = retrievalClient(projectId)
  const project = await retrieveHistoryContext({
    supabase: client,
    userId,
    conversationId: "current-conversation",
    projectId,
    query: "咖啡 后端架构",
    mode: "deep",
  })
  assert.match(project, /当前 Project 的独立历史池/)
  assert.doesNotMatch(project, /普通 Chat 的独立历史池/)

  const fallback = await retrieveHistoryContext({
    supabase: client,
    userId,
    conversationId: "current-conversation",
    projectId,
    query: "咖啡 后端架构",
    mode: "unknown" as "balanced",
  })
  assert.match(fallback, /主动检索到的历史对话片段/)
})

test("active retrieval returns empty for empty storage and propagates cancellation", async () => {
  type EmptyResult = { data: unknown[]; error: null }
  class EmptyQuery {
    select() { return this }
    eq() { return this }
    is() { return this }
    neq() { return this }
    in() { return this }
    order() { return this }
    limit() { return this }
    upsert() { return this }
    maybeSingle() { return Promise.resolve({ data: null, error: null }) }
    then<TResult1 = EmptyResult, TResult2 = never>(
      onfulfilled?: ((value: EmptyResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve({ data: [], error: null }).then(onfulfilled, onrejected)
    }
  }
  const empty = {
    from: () => new EmptyQuery(),
    rpc: async () => ({ data: [], error: null }),
  } as unknown as SupabaseServer
  await ensureConversationIndexed(empty, userId, "conversation")
  assert.equal(await retrieveHistoryContext({
    supabase: empty, userId, conversationId: "conversation", query: "history", mode: "deep",
  }), "")

  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  const broken = { from() { throw new Error("cancelled") } } as unknown as SupabaseServer
  await assert.rejects(
    ensureConversationIndexed(broken, userId, "conversation", controller.signal),
    /cancelled/,
  )
  await assert.rejects(retrieveHistoryContext({
    supabase: broken,
    userId,
    conversationId: "conversation",
    query: "history",
    mode: "balanced",
    signal: controller.signal,
  }), /cancelled/)
})
