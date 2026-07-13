import assert from "node:assert/strict"
import test from "node:test"
import {
  createIsolatedSyncManifest,
  parseIsolatedSyncManifest,
  planIsolatedWorkspaceHydration,
  serializeIsolatedSyncManifest,
} from "../lib/agent/isolated-sync"

const digest = (character: string) => character.repeat(64)
const manifest = (entries: Array<{ path: string; sha256: string; size: number }>) =>
  createIsolatedSyncManifest(entries)

test("unchanged incremental hydration performs zero uploads and deletes", () => {
  const current = manifest([
    { path: "README.md", sha256: digest("a"), size: 12 },
    { path: "src/index.ts", sha256: digest("b"), size: 30 },
  ])
  assert.deepEqual(planIsolatedWorkspaceHydration(current, current), {
    initial: false,
    uploads: [],
    deletes: [],
    manifest: current,
  })
})

test("incremental hydration uploads only changed/new paths and deletes removed paths", () => {
  const remote = manifest([
    { path: "README.md", sha256: digest("a"), size: 12 },
    { path: "removed.ts", sha256: digest("b"), size: 5 },
    { path: "src/index.ts", sha256: digest("c"), size: 20 },
  ])
  const local = manifest([
    { path: "README.md", sha256: digest("a"), size: 12 },
    { path: "src/index.ts", sha256: digest("d"), size: 21 },
    { path: "src/new.ts", sha256: digest("e"), size: 8 },
  ])
  const plan = planIsolatedWorkspaceHydration(local, remote)
  assert.deepEqual(plan.uploads, ["src/index.ts", "src/new.ts"])
  assert.deepEqual(plan.deletes, ["removed.ts"])
  assert.equal(plan.initial, false)
})

test("first hydration uploads the complete workspace without trusting remote paths", () => {
  const local = manifest([
    { path: "package.json", sha256: digest("a"), size: 40 },
    { path: "src/app.ts", sha256: digest("b"), size: 90 },
  ])
  const plan = planIsolatedWorkspaceHydration(local, null)
  assert.equal(plan.initial, true)
  assert.deepEqual(plan.uploads, ["package.json", "src/app.ts"])
  assert.deepEqual(plan.deletes, [])
})

test("remote manifests reject traversal, absolute, generated, and non-canonical paths", () => {
  for (const path of ["../escape", "/etc/passwd", "src//app.ts", "node_modules/pkg/index.js", "src/.env.local"]) {
    const encoded = `${JSON.stringify({
      version: 1,
      files: { [path]: { sha256: digest("a"), size: 1 } },
    })}\n`
    assert.throws(() => parseIsolatedSyncManifest(encoded), /同步路径/)
  }
})

test("manifest parser enforces exact schema and canonical encoding", () => {
  const current = manifest([{ path: "src/index.ts", sha256: digest("a"), size: 1 }])
  assert.deepEqual(parseIsolatedSyncManifest(serializeIsolatedSyncManifest(current)), current)
  assert.throws(
    () => parseIsolatedSyncManifest(`${JSON.stringify({ ...current, unexpected: true })}\n`),
    /结构非法/,
  )
  assert.throws(() => parseIsolatedSyncManifest(JSON.stringify(current)), /规范编码/)
})
