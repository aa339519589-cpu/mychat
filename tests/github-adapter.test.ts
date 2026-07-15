import assert from "node:assert/strict"
import test from "node:test"

import {
  commitFiles,
  createRepo,
  enablePages,
  canonicalGitHubPagesUrl,
  isCanonicalGitHubPagesUrl,
  listRepos,
  listTree,
  mergePullRequest,
  readFile,
  repoMeta,
  waitForPages,
} from "../lib/github"

test("GitHub read APIs validate response shapes and preserve limits", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async input => {
    const url = input.toString()
    if (url.includes("/user/repos")) return Response.json([
      { name: "repo", full_name: "owner/repo", private: true, description: "desc" },
      { invalid: true },
    ])
    if (url.includes("/git/trees/")) return Response.json({
      tree: [
        { type: "blob", path: "README.md" },
        { type: "blob", path: "src/index.ts" },
        { type: "tree", path: "src" },
      ],
      truncated: false,
    })
    if (url.includes("/contents/")) return Response.json({
      content: Buffer.from("hello").toString("base64"),
      sha: "file-sha",
      size: 5,
    })
    return Response.json({ default_branch: "main", permissions: { push: true }, private: true })
  }

  assert.deepEqual(await listRepos("token"), [{ name: "repo", full_name: "owner/repo", private: true, description: "desc" }])
  assert.deepEqual(await repoMeta("token", "owner/repo"), { defaultBranch: "main", canPush: true, isPrivate: true })
  assert.deepEqual(await listTree("token", "owner/repo", "main", 1), { paths: ["README.md"], truncated: true })
  assert.deepEqual(await readFile("token", "owner/repo", "README.md"), { content: "hello", sha: "file-sha" })
})

test("GitHub repository creation retries names and atomic commits preserve deletions", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const requests: Array<{ url: string; method: string; body: Record<string, unknown> }> = []
  let createAttempts = 0
  globalThis.fetch = async (input, init) => {
    const url = input.toString()
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    requests.push({ url, method, body })
    if (url.endsWith("/user/repos")) {
      createAttempts++
      if (createAttempts === 1) return Response.json({ message: "name already exists" }, { status: 422 })
      return Response.json({ full_name: "owner/my-project-2", default_branch: "main", html_url: "https://github.com/owner/my-project-2" })
    }
    if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base-sha" } })
    if (url.endsWith("/git/commits/base-sha")) return Response.json({ tree: { sha: "base-tree" } })
    if (url.endsWith("/git/blobs")) return Response.json({ sha: "blob-sha" })
    if (url.endsWith("/git/trees")) return Response.json({ sha: "tree-sha" })
    if (url.endsWith("/git/commits")) return Response.json({ sha: "commit-sha" })
    if (url.includes("/git/refs/heads/")) return Response.json({ ok: true })
    return Response.json({}, { status: 500 })
  }

  assert.deepEqual(await createRepo("token", "My Project!", "description", false), {
    fullName: "owner/my-project-2",
    defaultBranch: "main",
    htmlUrl: "https://github.com/owner/my-project-2",
  })
  assert.deepEqual(await commitFiles("token", "owner/repo", "main", [
    { path: "new.txt", content: "hello" },
    { path: "old.txt", content: null },
  ], "update"), { commitSha: "commit-sha" })
  const treeRequest = requests.find(request => request.url.endsWith("/git/trees"))
  assert.ok(Array.isArray(treeRequest?.body.tree))
  assert.equal(treeRequest.body.tree.length, 2)
  assert.equal((treeRequest.body.tree[1] as Record<string, unknown>).sha, null)
})

test("GitHub adapters reject incomplete, oversized, and unauthorized responses", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => new Response("missing", { status: 404 })
  assert.deepEqual(await listRepos("token"), [])
  assert.equal(await repoMeta("token", "owner/repo"), null)
  assert.deepEqual(await listTree("token", "owner/repo", "main"), { paths: [], truncated: false })
  assert.deepEqual(await readFile("token", "owner/repo", "missing.txt"), { error: "文件不存在" })
  globalThis.fetch = async () => Response.json([])
  assert.deepEqual(await readFile("token", "owner/repo", "directory"), { error: "这是一个目录，不是文件" })
  globalThis.fetch = async () => Response.json({ size: 130_000, sha: "sha", content: "" })
  assert.match((await readFile("token", "owner/repo", "large.txt") as { error: string }).error, /文件过大/)
  globalThis.fetch = async () => Response.json({ size: 1, content: "eA==" })
  assert.deepEqual(await readFile("token", "owner/repo", "no-sha.txt"), { error: "文件响应缺少版本标识" })
  globalThis.fetch = async () => Response.json({ permissions: {} })
  assert.equal(await repoMeta("token", "owner/repo"), null)
  globalThis.fetch = async () => Response.json({ message: "forbidden" }, { status: 403 })
  assert.match((await createRepo("token", "name", "", false) as { error: string }).error, /重新连接/)
  globalThis.fetch = async () => Response.json({ errors: [{ message: "invalid repository" }] }, { status: 500 })
  assert.match((await createRepo("token", "name", "", false) as { error: string }).error, /invalid repository/)
  globalThis.fetch = async () => Response.json({ message: "already exists" }, { status: 422 })
  assert.match((await createRepo("token", "name", "", false) as { error: string }).error, /换一个项目名/)
  globalThis.fetch = async () => { throw new Error("network down") }
  assert.match((await createRepo("token", "name", "", false) as { error: string }).error, /网络错误/)
})

test("GitHub Pages and merge state machines preserve every failure outcome", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => { throw new Error("offline") }
  assert.deepEqual(await mergePullRequest("token", "owner/repo", 1, "head"), { merged: false, error: "无法连接 GitHub 合并 Pull Request" })
  globalThis.fetch = async () => Response.json({ merged: false, message: "conflict" }, { status: 409 })
  assert.deepEqual(await mergePullRequest("token", "owner/repo", 1, "head"), { merged: false, error: "conflict" })
  globalThis.fetch = async () => Response.json({ status: "errored", html_url: "https://owner.github.io/repo/" })
  assert.deepEqual(await waitForPages("token", "owner/repo", { timeoutMs: 0 }), { status: "failed", url: "https://owner.github.io/repo/", error: "GitHub Pages 构建失败" })
  globalThis.fetch = async input => input.toString().includes("builds/latest") ? Response.json({ commit: "old", status: "built" }) : Response.json({ status: "built" })
  assert.deepEqual(await waitForPages("token", "owner/repo", { timeoutMs: 0, expectedCommitSha: "new" }), { status: "pending", url: "https://owner.github.io/repo/" })
  globalThis.fetch = async input => input.toString().includes("builds/latest") ? Response.json({ commit: "new", status: "errored" }) : Response.json({ status: "built" })
  assert.deepEqual(await waitForPages("token", "owner/repo", { timeoutMs: 0, expectedCommitSha: "new" }), { status: "failed", url: "https://owner.github.io/repo/", error: "GitHub Pages 最新版本构建失败" })
  globalThis.fetch = async () => Response.json({ status: "built" })
  assert.deepEqual(await waitForPages("token", "owner/repo", { timeoutMs: 0, verifyUrl: false }), { status: "ready", url: "https://owner.github.io/repo/" })
  globalThis.fetch = async () => Response.json({ message: "not allowed" }, { status: 500 })
  assert.deepEqual(await enablePages("token", "owner/repo", "main", { timeoutMs: 0 }), { status: "failed", url: "https://owner.github.io/repo/", error: "开启 Pages 失败：not allowed" })
  let pageCalls = 0
  globalThis.fetch = async (_input, init) => {
    pageCalls++
    if (init?.method === "POST") return Response.json({}, { status: 409 })
    if (init?.method === "PUT") return Response.json({ message: "update rejected" }, { status: 500 })
    return Response.json({ status: "building" })
  }
  assert.deepEqual(await enablePages("token", "owner/repo", "main", { timeoutMs: 0 }), { status: "failed", url: "https://owner.github.io/repo/", error: "更新 Pages 失败：update rejected" })
  assert.equal(pageCalls, 2)
})

test("GitHub Pages verification accepts only the canonical HTTPS origin", () => {
  assert.equal(canonicalGitHubPagesUrl("Owner/Repo"), "https://owner.github.io/Repo/")
  assert.equal(canonicalGitHubPagesUrl("owner/owner.github.io"), "https://owner.github.io/")
  assert.equal(isCanonicalGitHubPagesUrl("https://owner.github.io/repo/", "owner/repo"), true)
  assert.equal(isCanonicalGitHubPagesUrl("http://owner.github.io/repo/", "owner/repo"), false)
  assert.equal(isCanonicalGitHubPagesUrl("https://127.0.0.1/repo/", "owner/repo"), false)
  assert.equal(isCanonicalGitHubPagesUrl("https://owner.github.io.evil.test/repo/", "owner/repo"), false)
  assert.equal(isCanonicalGitHubPagesUrl("https://owner.github.io/other/", "owner/repo"), false)
  assert.equal(isCanonicalGitHubPagesUrl("https://user:pass@owner.github.io/repo/", "owner/repo"), false)
})

test("atomic GitHub commits stop at each malformed Git Data stage", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  async function failsAt(stage: "base" | "blob" | "tree" | "commit" | "ref") {
    globalThis.fetch = async input => {
      const url = input.toString()
      if (url.includes("/git/ref/heads/")) return Response.json({ object: { sha: "base-sha" } })
      if (url.endsWith("/git/commits/base-sha")) return stage === "base" ? Response.json({ tree: {} }) : Response.json({ tree: { sha: "base-tree" } })
      if (url.endsWith("/git/blobs")) return stage === "blob" ? Response.json({}) : Response.json({ sha: "blob-sha" })
      if (url.endsWith("/git/trees")) return stage === "tree" ? Response.json({}, { status: 500 }) : Response.json({ sha: "tree-sha" })
      if (url.endsWith("/git/commits")) return stage === "commit" ? Response.json({}, { status: 500 }) : Response.json({ sha: "commit-sha" })
      if (url.includes("/git/refs/heads/")) return stage === "ref" ? Response.json({ message: "non-fast-forward" }, { status: 409 }) : Response.json({})
      return Response.json({}, { status: 500 })
    }
    return commitFiles("token", "owner/repo", "main", [{ path: "file.txt", content: "content" }], "")
  }
  assert.deepEqual(await failsAt("base"), { error: "基树响应格式无效" })
  assert.deepEqual(await failsAt("blob"), { error: "Blob 响应格式无效 (file.txt)" })
  assert.deepEqual(await failsAt("tree"), { error: "创建树失败" })
  assert.deepEqual(await failsAt("commit"), { error: "创建提交失败" })
  assert.deepEqual(await failsAt("ref"), { error: "推送失败：non-fast-forward" })
})

test("GitHub defaults remain explicit for empty names, missing SHAs, and pending sites", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let repositoryBody: Record<string, unknown> = {}
  globalThis.fetch = async (_input, init) => {
    repositoryBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({ full_name: "owner/project", default_branch: "main", html_url: "https://github.com/owner/project" })
  }
  assert.ok("fullName" in await createRepo("token", "!!!", "", false))
  assert.equal(repositoryBody.name, "project")
  assert.equal(repositoryBody.description, "")
  globalThis.fetch = async () => Response.json({ full_name: "owner/project" })
  assert.deepEqual(await createRepo("token", "project", "", false), { error: "GitHub 返回的仓库信息不完整" })
  globalThis.fetch = async () => Response.json({ merged: true })
  assert.deepEqual(await mergePullRequest("token", "owner/repo", 1, "head"), { merged: true, commitSha: "" })
  globalThis.fetch = async input => input.toString().startsWith("https://api.github.com/") ? Response.json({ status: "built" }) : new Response("not ready", { status: 503 })
  assert.deepEqual(await waitForPages("token", "owner/repo", {
    timeoutMs: 0,
    siteProbe: async () => false,
  }), { status: "pending", url: "https://owner.github.io/repo/" })
  globalThis.fetch = async input => input.toString().includes("builds/latest") ? Response.json({ commit: "new", status: "building" }) : Response.json({ status: "built" })
  assert.deepEqual(await waitForPages("token", "owner/repo", { timeoutMs: 0, expectedCommitSha: "new" }), { status: "pending", url: "https://owner.github.io/repo/" })
})

test("GitHub adapters normalize alternate optional response shapes", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => Response.json({})
  assert.deepEqual(await listRepos("token"), [])
  globalThis.fetch = async () => Response.json([{ name: "repo", full_name: "owner/repo", private: false, description: null }])
  assert.deepEqual(await listRepos("token"), [{ name: "repo", full_name: "owner/repo", private: false, description: "" }])
  globalThis.fetch = async () => Response.json({ default_branch: "main", permissions: null, private: false })
  assert.deepEqual(await repoMeta("token", "owner/repo"), { defaultBranch: "main", canPush: false, isPrivate: false })
  globalThis.fetch = async () => Response.json({ tree: [{ type: "blob", path: "a" }], truncated: true })
  assert.deepEqual(await listTree("token", "owner/repo", "main", 5), { paths: ["a"], truncated: true })
  globalThis.fetch = async () => new Response("bad", { status: 500 })
  assert.deepEqual(await readFile("token", "owner/repo", "file"), { error: "文件读取失败" })
  globalThis.fetch = async () => new Response("not-json")
  assert.deepEqual(await readFile("token", "owner/repo", "file"), { error: "文件响应格式无效" })
  globalThis.fetch = async () => Response.json({}, { status: 404 })
  assert.match((await createRepo("token", "repo", "", false) as { error: string }).error, /重新连接/)
  globalThis.fetch = async () => Response.json({}, { status: 500 })
  assert.match((await createRepo("token", "repo", "", false) as { error: string }).error, /HTTP 500/)
  globalThis.fetch = async () => { throw "offline" }
  assert.match((await createRepo("token", "repo", "", false) as { error: string }).error, /无法连接到 GitHub/)
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls++
    if (init?.method === "POST") return Response.json({}, { status: 409 })
    if (init?.method === "PUT") return Response.json({})
    return Response.json({ status: "building" })
  }
  assert.deepEqual(await enablePages("token", "owner/repo", "main", { timeoutMs: 0 }), { status: "pending", url: "https://owner.github.io/repo/" })
  assert.equal(calls, 3)
  globalThis.fetch = async input => input.toString().includes("builds/latest") ? Response.json({ commit: "new", status: "built" }) : Response.json({ status: "built" })
  assert.deepEqual(await waitForPages("token", "owner/repo", { timeoutMs: 0, expectedCommitSha: "new", verifyUrl: false }), { status: "ready", url: "https://owner.github.io/repo/" })
})
