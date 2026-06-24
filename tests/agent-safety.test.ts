import test from "node:test"
import assert from "node:assert/strict"
import { classifyFileRisk, classifyPublishRisk, isProtectedBranch } from "../lib/agent/risk"
import { checkCommand } from "../lib/agent/command-security"

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
