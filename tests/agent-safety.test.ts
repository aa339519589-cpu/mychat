import test from "node:test"
import assert from "node:assert/strict"
import { classifyFileRisk, classifyPublishRisk, isProtectedBranch } from "../lib/agent/risk"
import { checkCommand, sanitizeCommandOutput } from "../lib/agent/command-security"
import { isolatedShellConfigured } from "../lib/agent/isolated-shell"
import {
  agentExecutionBackend,
  assertProductionAgentSandbox,
  localWorkspaceExecutionAllowed,
  sandboxEgressAllowlist,
} from "../lib/agent/execution-policy"
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
  assert.equal(checkCommand("").allowed, false)
  assert.equal(checkCommand("x".repeat(4_001)).allowed, false)
  assert.equal(checkCommand("git push origin main").allowed, false)
  assert.equal(checkCommand("npm test").allowed, true)
  assert.equal(checkCommand("git status; printenv").allowed, false)
  assert.equal(checkCommand("git status && cat .env").allowed, false)
  assert.equal(checkCommand("git status$(printenv)").allowed, false)
  assert.equal(checkCommand("git statusx").allowed, false)
  assert.equal(checkCommand("npm run arbitrary-script").allowed, false)
  assert.equal(checkCommand("python -c 'import os'").allowed, false)
  assert.equal(checkCommand("cat ../../.env").allowed, false)
  assert.equal(checkCommand("cat /etc/passwd").allowed, false)
})

test("workspace shell output redacts every credential shape", () => {
  assert.equal(sanitizeCommandOutput(""), "")
  const output = sanitizeCommandOutput([
    `raw=${"A".repeat(40)}`,
    `sk-${"a".repeat(24)}`,
    `tvly-${"b".repeat(24)}`,
    `sb_publishable_${"c".repeat(12)}`,
    "Authorization: Bearer secret",
    "gh_access_token=secret",
    "https://x-access-token:secret@example.com",
  ].join("\n"))
  for (const secret of ["A".repeat(40), "a".repeat(24), "b".repeat(24),
    "c".repeat(12), "Bearer secret", "gh_access_token=secret", "x-access-token:secret"]) {
    assert.equal(output.includes(secret), false)
  }
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

test("production can never opt into host shell execution", () => {
  const productionOverride = {
    NODE_ENV: "production",
    ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: "true",
  }
  assert.equal(localWorkspaceExecutionAllowed(productionOverride), false)
  assert.equal(agentExecutionBackend(productionOverride), "disabled")
  assert.equal(agentExecutionBackend({ ...productionOverride, E2B_API_KEY: "e2b-key" }), "isolated")
  assert.equal(agentExecutionBackend({ ...productionOverride, E2B_API_KEY: "   " }), "disabled")
})

test("host execution fails closed outside explicitly named local runtimes", () => {
  const unsafeFlag = { ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: "true" }
  assert.equal(localWorkspaceExecutionAllowed(unsafeFlag), false)
  assert.equal(localWorkspaceExecutionAllowed({ ...unsafeFlag, NODE_ENV: "staging" }), false)
  assert.equal(localWorkspaceExecutionAllowed({ ...unsafeFlag, NODE_ENV: "development" }), true)
  assert.equal(localWorkspaceExecutionAllowed({ ...unsafeFlag, NODE_ENV: "test" }), true)
})

test("production startup requires the isolated sandbox", () => {
  assert.throws(
    () => assertProductionAgentSandbox({ NODE_ENV: "production" }),
    /requires a non-empty E2B_API_KEY/,
  )
  assert.doesNotThrow(() => assertProductionAgentSandbox({
    NODE_ENV: "production",
    E2B_API_KEY: "e2b-key",
  }))
  assert.doesNotThrow(() => assertProductionAgentSandbox({ NODE_ENV: "development" }))
})

test("sandbox egress is a bounded public-host allowlist", () => {
  const defaults = sandboxEgressAllowlist({})
  assert.ok(defaults.includes("registry.npmjs.org"))
  assert.ok(defaults.includes("github.com"))
  assert.equal(defaults.some(rule => rule.includes("0.0.0.0") || rule === "*"), false)
  assert.ok(sandboxEgressAllowlist({
    AGENT_SANDBOX_EGRESS_ALLOWLIST: "packages.example.com,*.assets.example.com",
  }).includes("packages.example.com"))
  assert.throws(() => sandboxEgressAllowlist({
    AGENT_SANDBOX_EGRESS_ALLOWLIST: "127.0.0.1,metadata.internal",
  }), /Invalid AGENT_SANDBOX_EGRESS_ALLOWLIST/)
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
