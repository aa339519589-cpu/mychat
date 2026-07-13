import assert from "node:assert/strict"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import test from "node:test"
import {
  collectIsolatedWorkspaceFiles,
  MAX_ISOLATED_FILE_BYTES,
  REMOTE_WORKSPACE_ROOT,
} from "../lib/agent/isolated-files"
import { workspaceRoot } from "../lib/agent/workspace"

function workspace(t: test.TestContext) {
  const userId = `isolated-user-${crypto.randomUUID()}`
  const taskId = `isolated-task-${crypto.randomUUID()}`
  const root = workspaceRoot(taskId, userId)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { userId, taskId, root }
}

test("isolated upload collects bounded normal and binary files", t => {
  const current = workspace(t)
  mkdirSync(`${current.root}/src`, { recursive: true })
  writeFileSync(`${current.root}/src/index.ts`, "export const value = 1\n")
  writeFileSync(`${current.root}/image.bin`, Buffer.from([0, 1, 2, 3]))
  const files = collectIsolatedWorkspaceFiles(current.userId, current.taskId)
  assert.deepEqual(files.map(file => file.path).sort(), [
    `${REMOTE_WORKSPACE_ROOT}/image.bin`,
    `${REMOTE_WORKSPACE_ROOT}/src/index.ts`,
  ])
  assert.ok(files.every(file => file.data instanceof ArrayBuffer))
})

test("isolated upload blocks private package-manager and Docker credentials", t => {
  const npm = workspace(t)
  writeFileSync(`${npm.root}/.npmrc`, "registry=https://example.com\n")
  assert.throws(() => collectIsolatedWorkspaceFiles(npm.userId, npm.taskId), /敏感配置/)

  const docker = workspace(t)
  mkdirSync(`${docker.root}/.docker`, { recursive: true })
  writeFileSync(`${docker.root}/.docker/config.json`, "{}")
  assert.throws(() => collectIsolatedWorkspaceFiles(docker.userId, docker.taskId), /敏感配置/)
})

test("isolated upload blocks detected secrets and oversized files", t => {
  const secret = workspace(t)
  writeFileSync(`${secret.root}/config.txt`, "Authorization: Bearer sk-test-secret-value-1234567890")
  assert.throws(() => collectIsolatedWorkspaceFiles(secret.userId, secret.taskId), /疑似密钥/)

  const oversized = workspace(t)
  writeFileSync(`${oversized.root}/large.bin`, Buffer.alloc(MAX_ISOLATED_FILE_BYTES + 1))
  assert.throws(() => collectIsolatedWorkspaceFiles(oversized.userId, oversized.taskId), /文件过大/)
})
