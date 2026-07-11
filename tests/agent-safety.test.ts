import test from "node:test"
import assert from "node:assert/strict"
import { classifyFileRisk, classifyPublishRisk, isProtectedBranch } from "../lib/agent/risk"
import { checkCommand } from "../lib/agent/command-security"
import { isolatedShellConfigured } from "../lib/agent/isolated-shell"
import { validatePath } from "../lib/agent/path-security"
import { mkdirSync, rmSync, symlinkSync } from "node:fs"

test("protected branches can never be published", () => {
  for (const branch of ["main", "master", "production", "prod", "release"]) {
    assert.equal(isProtectedBranch(branch), true)
    assert.equal(classifyPublishRisk([], branch).blocked, true)
  }
  assert.equal(classifyPublishRisk([], "agent/readme-update").blocked, false)
})

test("sensitive files are blocked and workflows require confirmation", () => {
  assert.equal(classifyFileRisk([".env.production"]).blocked, true)
  assert.equal(classifyFileRisk([".github/workflows/deploy.yml"]).needsConfirmation, true)
})

test("workspace shell blocks direct main pushes", () => {
  assert.equal(checkCommand("git push origin main").allowed, false)
  assert.equal(checkCommand("npm test").allowed, true)
})

test("isolated shell activates only when its own key is configured", { concurrency: false }, t => {
  const previous = process.env.E2B_API_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = previous
  })
  delete process.env.E2B_API_KEY
  assert.equal(isolatedShellConfigured(), false)
  process.env.E2B_API_KEY = "test-key"
  assert.equal(isolatedShellConfigured(), true)
})

test("workspace paths reject symlinks that escape the workspace", t => {
  const root = `/tmp/mychat-path-test-${Date.now()}`
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(root, { recursive: true })
  symlinkSync("/tmp", `${root}/escape`)
  const result = validatePath(root, "escape/outside.txt")
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /符号链接/)
})
