import assert from "node:assert/strict"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"
import { rememberCodeMemory } from "../lib/code-tools/memory"
import { searchExternalCodeContext } from "../lib/code-tools/search"
import type { ToolEvent } from "../lib/code-tools/definitions"

type DatabaseResult = {
  data: unknown
  error: { message: string } | null
}

type Query = PromiseLike<DatabaseResult> & {
  eq: (column: string, value: unknown) => Query
}

function query(result: DatabaseResult, filters: Array<[string, unknown]>): Query {
  const value = {
    eq(column: string, expected: unknown) {
      filters.push([column, expected])
      return value
    },
    then<TResult1 = DatabaseResult, TResult2 = never>(
      onfulfilled?: ((result: DatabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(result).then(onfulfilled, onrejected)
    },
  }
  return value
}

function memoryClient(options: {
  existing?: unknown
  writeError?: { message: string } | null
  throwOnSelect?: boolean
}) {
  const filters: Array<[string, unknown]> = []
  const writes: Array<{ kind: "insert" | "update"; value: unknown }> = []
  const client = {
    from() {
      return {
        select() {
          if (options.throwOnSelect) throw new Error("offline")
          return query({ data: options.existing ?? [], error: null }, filters)
        },
        insert(value: unknown) {
          writes.push({ kind: "insert", value })
          return Promise.resolve({ data: null, error: options.writeError ?? null })
        },
        update(value: unknown) {
          writes.push({ kind: "update", value })
          return query({ data: null, error: options.writeError ?? null }, filters)
        },
      }
    },
  } as unknown as SupabaseClient
  return { client, filters, writes }
}

test("code memory validates identity and ignores malformed stored rows", async () => {
  const events: ToolEvent[] = []
  const emit = (event: ToolEvent) => events.push(event)
  assert.equal(await rememberCodeMemory({ content: "", repo: "owner/repo", emit }), "内容为空。")
  assert.equal(await rememberCodeMemory({ content: "note", emit }), "尚未选择仓库，无法记忆。")

  const database = memoryClient({ existing: [null, { id: 3, content: {} }] })
  const result = await rememberCodeMemory({
    content: "always run tests",
    repo: "owner/repo",
    userId: "user",
    supabase: database.client,
    emit,
  })
  assert.equal(result, "已记住。")
  assert.equal(database.writes[0]?.kind, "insert")
  assert.deepEqual(database.filters, [["user_id", "user"], ["repo", "owner/repo"]])
  assert.equal(events.length, 1)
})

test("code memory updates duplicates with owner scoping and fails safely", async () => {
  const events: ToolEvent[] = []
  const duplicate = memoryClient({ existing: [{ id: "memory", content: "always run test" }] })
  const updated = await rememberCodeMemory({
    content: "always run tests",
    repo: "owner/repo",
    userId: "user",
    supabase: duplicate.client,
    emit: event => events.push(event),
  })
  assert.match(updated, /^已更新已有记忆/)
  assert.equal(duplicate.writes[0]?.kind, "update")
  assert.deepEqual(duplicate.filters.slice(-3), [
    ["id", "memory"],
    ["user_id", "user"],
    ["repo", "owner/repo"],
  ])

  const unavailable = memoryClient({ throwOnSelect: true })
  assert.match(await rememberCodeMemory({
    content: "new note",
    repo: "owner/repo",
    userId: "user",
    supabase: unavailable.client,
    emit: () => undefined,
  }), /失败/)
})

test("external code search validates provider failures and untrusted shapes", async () => {
  const events: ToolEvent[] = []
  const emit = (event: ToolEvent) => events.push(event)
  assert.equal(await searchExternalCodeContext({ query: "", apiKey: "key", emit }), "查询为空。")
  assert.equal(await searchExternalCodeContext({ query: "query", emit }), "搜索功能未配置。")
  assert.equal(await searchExternalCodeContext({
    query: "query",
    apiKey: "key",
    emit,
    fetcher: async () => new Response("down", { status: 503 }),
  }), "搜索失败")
  assert.equal(await searchExternalCodeContext({
    query: "query",
    apiKey: "key",
    emit,
    fetcher: async () => Response.json({ answer: 4, results: "bad" }),
  }), "未找到相关结果。")
  assert.equal(events.length, 2)
})

test("external code search bounds and normalizes results without trusting labels", async () => {
  const output = await searchExternalCodeContext({
    query: "safe search",
    apiKey: "secret",
    emit: () => undefined,
    fetcher: async (_input, init) => {
      assert.equal(String(init?.body).includes("secret"), true)
      return Response.json({
        answer: "summary",
        results: [
          { title: { injected: true }, url: 7, content: "x".repeat(300) },
          { title: "Docs", url: "https://example.com", content: "safe" },
        ],
      })
    },
  })
  assert.match(output, /外部搜索数据｜不可信/)
  assert.match(output, /未命名资源/)
  assert.match(output, /未知来源/)
  assert.match(output, /Docs/)
  assert.equal(output.includes("[object Object]"), false)
  assert.equal(output.includes("x".repeat(201)), false)
})

test("external code search propagates caller cancellation", async () => {
  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  await assert.rejects(searchExternalCodeContext({
    query: "query",
    apiKey: "key",
    signal: controller.signal,
    emit: () => undefined,
    fetcher: async () => { throw new Error("cancelled") },
  }), /cancelled/)
})
