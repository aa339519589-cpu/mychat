import assert from "node:assert/strict"
import test from "node:test"
import type { SupabaseClient } from "@supabase/supabase-js"

import { addQuotaUsage, checkQuotaExceeded } from "../lib/quota"
import { fetchUrlTool, readPage } from "../lib/tools/fetch-url"
import { memoryTools } from "../lib/tools/memory"
import { webSearchTool } from "../lib/tools/web-search"
import { validate } from "../lib/validation"

function supabase(value: unknown): SupabaseClient {
  return value as SupabaseClient
}

function quotaClient(data: Record<string, unknown> | null, error: unknown = null): SupabaseClient {
  return supabase({ rpc: async () => ({ data, error }) })
}

function resultQuery(value: unknown) {
  const promise = Promise.resolve(value)
  return { eq() { return this }, then: promise.then.bind(promise) }
}

test("quota windows, balance fallback, and atomic accounting cover every decision", async () => {
  const now = Date.now()
  assert.deepEqual(await checkQuotaExceeded(null, "user"), { exceeded: false })
  assert.ok(now > 0)
  assert.deepEqual(await checkQuotaExceeded(quotaClient({
    tokens5h: 0,
    tokens7d: 0,
    balance: 0,
    limit5h: 500_000,
    limit7d: 10_000_000,
  }), "user"), { exceeded: false })
  assert.deepEqual(await checkQuotaExceeded(quotaClient({
    tokens5h: 500_000, tokens7d: 1, balance: 0, limit5h: 500_000, limit7d: 10_000_000,
  }), "user"), { exceeded: true, which: "5h" })
  assert.deepEqual(await checkQuotaExceeded(quotaClient({
    tokens5h: 1, tokens7d: 10_000_000, balance: 9, limit5h: 500_000, limit7d: 10_000_000,
  }), "user"), { exceeded: false, usingBalance: true })
  assert.deepEqual(await checkQuotaExceeded(quotaClient(null, { code: "offline" }), "user"), { exceeded: false, unavailable: true })
  assert.deepEqual(await checkQuotaExceeded(supabase({ rpc: () => { throw new Error("offline") } }), "user"), { exceeded: false, unavailable: true })

  const calls: Array<Record<string, unknown>> = []
  const atomic = supabase({
    rpc: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, ...input })
      return { error: null }
    },
  })
  await addQuotaUsage(atomic, "user", 10, "grok-4", false, true)
  await addQuotaUsage(atomic, "user", 10, "flash", false)
  await addQuotaUsage(atomic, "user", 10, "flash", true)
  await addQuotaUsage(atomic, "user", 0, "flash", true)
  assert.deepEqual(calls.map(call => call.weighted_tokens), [30, 8, 10])
})

test("validation rejects malformed strings, UUIDs, numbers, and arrays", () => {
  assert.equal(validate.string("hello", "name", { minLength: 2, maxLength: 8 }), "hello")
  assert.throws(() => validate.string(1, "name"), /must be a string/)
  assert.throws(() => validate.string("a", "name", { minLength: 2 }), /at least 2/)
  assert.throws(() => validate.string("long", "name", { maxLength: 3 }), /at most 3/)
  assert.equal(validate.uuid("00000000-0000-4000-8000-000000000001", "id"), "00000000-0000-4000-8000-000000000001")
  assert.throws(() => validate.uuid("no", "id"), /valid UUID/)
  assert.equal(validate.number(3, "count", { min: 1, max: 4, isInteger: true }), 3)
  assert.throws(() => validate.number(Number.NaN, "count"), /must be a number/)
  assert.throws(() => validate.number(1.5, "count", { isInteger: true }), /integer/)
  assert.throws(() => validate.number(0, "count", { min: 1 }), /at least 1/)
  assert.throws(() => validate.number(5, "count", { max: 4 }), /at most 4/)
  assert.deepEqual(validate.array([1], "items", { minLength: 1, maxLength: 2 }), [1])
  assert.throws(() => validate.array({}, "items"), /must be an array/)
  assert.throws(() => validate.array([], "items", { minLength: 1 }), /at least 1/)
  assert.throws(() => validate.array([1, 2], "items", { maxLength: 1 }), /at most 1/)
})

test("page reader blocks unsafe URLs and bounds untrusted page content", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  assert.match(await readPage("not-a-url"), /无效的网址/)
  assert.match(await readPage("https://user:pass@example.com"), /用户名或密码/)
  assert.match(await readPage("http://127.0.0.1/private"), /私有网络/)
  globalThis.fetch = async () => new Response("A".repeat(8_100))
  const bounded = await readPage("https://example.com/article")
  assert.match(bounded, /外部网页数据/)
  assert.match(bounded, /已截断/)
  globalThis.fetch = async () => new Response("")
  assert.match(await readPage("https://example.com/empty"), /没有可提取/)
  globalThis.fetch = async () => new Response("no", { status: 403 })
  assert.match(await readPage("https://example.com/locked"), /403/)
  globalThis.fetch = async () => { throw new Error("offline") }
  assert.match(await readPage("https://example.com/down"), /超时或出错/)
  globalThis.fetch = async () => new Response("tool body")
  const outcome = await fetchUrlTool.execute({ url: "https://example.com/tool" }, { supabase: null, userId: null })
  assert.match(outcome.result, /tool body/)
})

test("web search validates and deduplicates untrusted provider results", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  const previousKey = process.env.TAVILY_API_KEY
  process.env.TAVILY_API_KEY = "test-key"
  t.after(() => {
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = previousKey
  })
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls++
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(body.api_key, "test-key")
    return Response.json({
      answer: "summary",
      results: [
        { title: "One", url: "https://one.example", content: "first" },
        { title: "Duplicate", url: "https://ONE.example", content: "duplicate" },
        { title: "Two", url: "https://two.example", content: "second" },
        { title: 3, url: null },
      ],
    })
  }
  const outcome = await webSearchTool.execute({ query: "current topic" }, {
    supabase: null, userId: null, searchMode: "deep", latestBeijingDate: "2026-07-13",
  })
  assert.ok(calls > 1)
  assert.match(outcome.result, /深度联网/)
  assert.match(outcome.result, /低于目标下限/)
  assert.deepEqual(outcome.event, { search: {
    query: "current topic",
    results: [
      { title: "One", url: "https://one.example" },
      { title: "Two", url: "https://two.example" },
    ],
  } })
})

test("memory tools handle create, duplicate, update, delete, and project scoping", async () => {
  const id = "00000000-0000-4000-8000-000000000001"
  const mutations: Array<{ operation: string; table: string; value?: unknown }> = []
  let existing: Array<{ id: string; content: string }> = []
  const client = supabase({
    from(table: string) {
      return {
        select() { return resultQuery({ data: existing, error: null }) },
        insert(value: unknown) { mutations.push({ operation: "insert", table, value }); return Promise.resolve({ error: null }) },
        update(value: unknown) { mutations.push({ operation: "update", table, value }); return resultQuery({ error: null }) },
        delete() { mutations.push({ operation: "delete", table }); return resultQuery({ error: null }) },
      }
    },
  })
  const context = { supabase: client, userId: "user" }
  const remember = memoryTools.find(tool => tool.name === "remember")!
  const update = memoryTools.find(tool => tool.name === "update_memory")!
  const forget = memoryTools.find(tool => tool.name === "forget")!
  const rememberProject = memoryTools.find(tool => tool.name === "remember_project")!
  assert.equal((await remember.execute({ content: "new preference" }, context)).result, "操作成功")
  existing = [{ id, content: "用户喜欢喝咖啡" }]
  assert.match((await remember.execute({ content: "用户喜欢喝咖啡" }, context)).result, /高度相似/)
  assert.equal((await update.execute({ id, content: "updated" }, context)).result, "操作成功")
  assert.equal((await forget.execute({ id }, context)).result, "操作成功")
  assert.equal((await update.execute({ id: "bad", content: "updated" }, context)).result, "操作失败")
  assert.equal((await rememberProject.execute({ content: "project" }, context)).result, "操作失败")
  assert.ok(mutations.some(item => item.operation === "insert" && item.table === "memories"))
  assert.ok(mutations.some(item => item.operation === "update"))
  assert.ok(mutations.some(item => item.operation === "delete"))
})

test("memory tools validate malformed rows and scope every project mutation", async () => {
  const id = "00000000-0000-4000-8000-000000000002"
  const filters: Array<[string, unknown]> = []
  const mutations: Array<{ operation: string; table: string }> = []
  let existing: unknown = [null, { id: 3, content: {} }, { id, content: "项目使用严格后端测试" }]
  let writeError: { message: string } | null = null
  const client = supabase({
    from(table: string) {
      const query = {
        eq(field: string, value: unknown) { filters.push([field, value]); return query },
        then<TResult1 = { data?: unknown; error: typeof writeError }, TResult2 = never>(
          onfulfilled?: ((value: { data?: unknown; error: typeof writeError }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          return Promise.resolve({ data: existing, error: writeError }).then(onfulfilled, onrejected)
        },
      }
      return {
        select() { return query },
        insert() { mutations.push({ operation: "insert", table }); return Promise.resolve({ error: writeError }) },
        update() { mutations.push({ operation: "update", table }); return query },
        delete() { mutations.push({ operation: "delete", table }); return query },
      }
    },
  })
  const context = { supabase: client, userId: "user", projectId: "project" }
  const remember = memoryTools.find(tool => tool.name === "remember_project")!
  const update = memoryTools.find(tool => tool.name === "update_project_memory")!
  const forget = memoryTools.find(tool => tool.name === "forget_project")!

  assert.match((await remember.execute({ content: "项目使用严格后端测试" }, context)).result, /高度相似/)
  existing = []
  assert.equal((await remember.execute({ content: "项目新增约定" }, context)).result, "操作成功")
  assert.equal((await update.execute({ id, content: "项目更新约定" }, context)).result, "操作成功")
  assert.equal((await forget.execute({ id }, context)).result, "操作成功")
  assert.ok(filters.filter(([field, value]) => field === "project_id" && value === "project").length >= 3)
  assert.ok(mutations.every(mutation => mutation.table === "project_memories"))

  writeError = { message: "offline" }
  assert.equal((await remember.execute({ content: "数据库失败" }, context)).result, "操作失败")
  assert.equal((await update.execute({ id, content: "数据库失败" }, context)).result, "操作失败")
  assert.equal((await forget.execute({ id }, context)).result, "操作失败")
  assert.equal((await remember.execute({ content: "x".repeat(5001) }, context)).result, "操作失败")
})

test("backend tools fail safely across unavailable providers and invalid contexts", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  const previousKey = process.env.TAVILY_API_KEY
  t.after(() => {
    globalThis.fetch = originalFetch
    if (previousKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = previousKey
  })
  delete process.env.TAVILY_API_KEY
  assert.match((await webSearchTool.execute({ query: "topic" }, { supabase: null, userId: null, searchMode: "web" })).result, /没有找到/)
  process.env.TAVILY_API_KEY = "key"
  globalThis.fetch = async () => new Response("down", { status: 503 })
  assert.match((await webSearchTool.execute({ query: "topic" }, { supabase: null, userId: null, searchMode: "web" })).result, /没有找到/)
  const remember = memoryTools.find(tool => tool.name === "remember")!
  const rememberProject = memoryTools.find(tool => tool.name === "remember_project")!
  assert.equal(remember.enabled({ loggedIn: true, memoryEnabled: true, searchMode: "off" }), true)
  assert.equal(remember.enabled({ loggedIn: false, memoryEnabled: true, searchMode: "off" }), false)
  assert.equal(rememberProject.enabled({ loggedIn: true, memoryEnabled: true, searchMode: "off", projectId: "project" }), true)
  assert.equal((await remember.execute({ content: "x" }, { supabase: null, userId: null })).result, "操作失败")
  assert.equal((await remember.execute({ content: "" }, { supabase: supabase({}), userId: "user" })).result, "操作失败")
  await addQuotaUsage(supabase({ rpc: async () => ({ error: { code: "offline" } }) }), "user", 1, "flash", true)
  await addQuotaUsage(supabase({ rpc: async () => { throw new Error("offline") } }), "user", 1, "flash", true)
  await addQuotaUsage(null, "user", 1, "flash", true)
})
