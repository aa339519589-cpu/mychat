import assert from "node:assert/strict"
import test from "node:test"

import type { SupabaseServer } from "../lib/api/guard"
import { ensureConversationIndexed, retrieveHistoryContext, retrieveHistoryWithSources } from "../lib/llm/active-retrieval"

const now = "2026-07-13T00:00:00.000Z"
const userId = "20000000-0000-4000-8000-000000000001"

test('history lookup starts independent text search while anchor storage is still pending', { concurrency: false, timeout: 2_000 }, async t => {
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
  let releaseAnchors: (() => void) | undefined
  const anchorGate = new Promise<void>(resolve => { releaseAnchors = resolve })
  let textSearchStarted = false
  class Query {
    select() { return this } eq() { return this } is() { return this }
    neq() { return this } order() { return this } limit() { return this }
    async then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
      await anchorGate
      return resolve({ data: [], error: null })
    }
  }
  const client = {
    from: () => new Query(), rpc: async () => {
      textSearchStarted = true
      releaseAnchors?.()
      return { data: [], error: null }
    },
  } as unknown as SupabaseServer
  const result = await retrieveHistoryWithSources({
    supabase: client, userId, conversationId: 'current', query: 'previous coffee plan', mode: 'balanced',
  })
  assert.equal(textSearchStarted, true)
  assert.deepEqual(result, { renderedContext: '', sources: [] })
})

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
    gt() { return this }
    gte() { return this }
    lte() { return this }
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
          { id: "current-user", seq: 1, role: "user", content: "current question", created_at: now, conversation_id: "current-conversation" },
          { id: "current-answer", seq: 2, role: "assistant", content: "current answer", created_at: now, conversation_id: "current-conversation" },
        ], error: null }
      }
      if (this.filters.get("role") === "user") {
        return { data: [{ id: "history-user", seq: 2, role: "user", content: "用户喜欢咖啡和后端架构", created_at: now, conversation_id: "history-conversation" }], error: null }
      }
      return { data: [
        { id: "history-before", seq: 1, role: "assistant", content: "What do you like?", created_at: now, conversation_id: "history-conversation" },
        { id: "history-user", seq: 2, role: "user", content: "用户喜欢咖啡和后端架构", created_at: now, conversation_id: "history-conversation" },
        { id: "history-after", seq: 3, role: "assistant", content: "Noted", created_at: now, conversation_id: "history-conversation" },
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
  const withSources = await retrieveHistoryWithSources({
    supabase: client,
    userId,
    conversationId: "current-conversation",
    query: "咖啡 后端架构",
    mode: "balanced",
  })
  assert.match(withSources.renderedContext, /History/)
  assert.ok(withSources.sources.some(source => source.conversationId === "history-conversation"))
  assert.ok(withSources.sources.every(source => source.messageStartId && source.snippet.length > 0))
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

test("active retrieval keeps Project history isolated and defaults unknown modes", { concurrency: false }, async t => {
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
    gt() { return this }
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

test("active retrieval finds a mid-thread match and supplies the opening and latest messages", { concurrency: false }, async t => {
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

  const messages = Array.from({ length: 1200 }, (_, index) => {
    const seq = index + 1
    const role = seq % 2 === 1 ? "user" : "assistant"
    let content = `thread message ${seq}`
    if (seq === 1) content = "conversation opening: sunrise in the mountains"
    if (seq === 605) content = "needle historical fact: the launch date was June 12"
    if (seq === 1199) content = "latest update: the launch moved to Friday"
    return {
      id: `message-${seq}`,
      seq,
      role,
      content,
      user_id: userId,
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
      conversation_id: "long-history",
    }
  })
  type Result = { data: unknown; error: null }
  const indexedChunks: unknown[] = []
  class Query {
    private filters = new Map<string, unknown>()
    private ranges = new Map<string, { gt?: number; gte?: number; lte?: number }>()
    private sort: { field: string; ascending: boolean } | null = null
    private maxRows: number | null = null
    private operation: "select" | "upsert" = "select"
    private payload: unknown = null
    constructor(private readonly table: string) {}
    select() { return this }
    upsert(payload: unknown) { this.operation = "upsert"; this.payload = payload; return this }
    eq(field: string, value: unknown) { this.filters.set(field, value); return this }
    is(field: string, value: unknown) { this.filters.set(field, value); return this }
    neq(field: string, value: unknown) { this.filters.set(`neq:${field}`, value); return this }
    in(field: string, value: unknown[]) { this.filters.set(`in:${field}`, value); return this }
    gt(field: string, value: number) { this.ranges.set(field, { ...this.ranges.get(field), gt: value }); return this }
    gte(field: string, value: number) { this.ranges.set(field, { ...this.ranges.get(field), gte: value }); return this }
    lte(field: string, value: number) { this.ranges.set(field, { ...this.ranges.get(field), lte: value }); return this }
    order(field: string, options: { ascending: boolean }) { this.sort = { field, ascending: options.ascending }; return this }
    limit(value: number) { this.maxRows = value; return this }
    private result(): Result {
      if (this.table === "conversation_chunks") {
        if (this.operation === "upsert" && Array.isArray(this.payload)) indexedChunks.push(...this.payload)
        return { data: [], error: null }
      }
      let rows: Array<Record<string, unknown>> = this.table === "conversations"
        ? [{ id: "long-history", user_id: userId, title: "Long history", project_id: null, updated_at: now }]
        : this.table === "messages" ? messages : []
      rows = rows.filter(row => {
        for (const [field, value] of this.filters) {
          if (field.startsWith("neq:")) {
            if (row[field.slice(4)] === value) return false
          } else if (field.startsWith("in:")) {
            if (!(value as unknown[]).includes(row[field.slice(3)])) return false
          } else if (row[field] !== value) return false
        }
        for (const [field, range] of this.ranges) {
          const value = row[field]
          if (typeof value !== "number") return false
          if (range.gt !== undefined && value <= range.gt) return false
          if (range.gte !== undefined && value < range.gte) return false
          if (range.lte !== undefined && value > range.lte) return false
        }
        return true
      })
      if (this.sort) {
        const { field, ascending } = this.sort
        rows = [...rows].sort((a, b) => {
          const left = a[field]
          const right = b[field]
          const order = typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left ?? "").localeCompare(String(right ?? ""))
          return ascending ? order : -order
        })
      }
      if (this.maxRows !== null) rows = rows.slice(0, this.maxRows)
      return { data: rows, error: null }
    }
    maybeSingle() {
      const result = this.result()
      const rows = result.data as Array<Record<string, unknown>>
      return Promise.resolve({ ...result, data: rows[0] ?? null })
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
          id: "long-thread-chunk",
          conversation_id: "long-history",
          conversation_title: "Long history",
          project_id: null,
          message_start_id: "message-601",
          message_end_id: "message-608",
          content: "needle historical fact: the launch date was June 12",
          similarity: 0.8,
          created_at: now,
        }], error: null }
      : { data: [], error: null },
  } as unknown as SupabaseServer

  await ensureConversationIndexed(client, userId, "long-history")
  assert.equal(indexedChunks.length, 24)
  assert.ok(indexedChunks.some(chunk => JSON.stringify(chunk).includes("message-1200")))

  const result = await retrieveHistoryWithSources({
    supabase: client,
    userId,
    conversationId: "current-conversation",
    query: "needle historical fact",
    mode: "balanced",
  })
  assert.match(result.renderedContext, /conversation opening: sunrise in the mountains/)
  assert.match(result.renderedContext, /needle historical fact: the launch date was June 12/)
  assert.match(result.renderedContext, /latest update: the launch moved to Friday/)
  assert.ok(result.sources.some(source => source.snippet.includes("开篇：") && source.snippet.includes("最近：")))
})
