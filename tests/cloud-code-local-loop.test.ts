import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { applyWorkspacePatch, dryRunWorkspacePatch } from '../lib/agent/patch'
import { runInWorkspace } from '../lib/agent/shell'
import { snapshotDir } from '../lib/agent/snapshot/paths'
import {
  getWorkspaceDiff, listWorkspaceFiles, readWorkspaceFile, searchWorkspaceFiles,
} from '../lib/agent/workspace'
import { workspaceRoot } from '../lib/agent/workspace-paths'
import type { SupabaseClient } from '../lib/supabase/types'

// This test uses REAL Git, filesystem, patch, snapshots, and child processes.
// The owner/audit database is a fixture. It is NOT a cloud/E2B or model test.
function auditFixture(owner: string, taskIDs: string[]) {
  const audit: Array<{ table: string; row: Record<string, unknown> }> = []
  const client = {
    from(table: string) {
      let row: Record<string, unknown> = {}
      let writing = false
      const filters: Record<string, unknown> = {}
      const query = {
        select() { return query },
        eq(key: string, value: unknown) { filters[key] = value; return query },
        insert(value: Record<string, unknown>) {
          row = value; writing = true; audit.push({ table, row: value }); return query
        },
        update(value: Record<string, unknown>) {
          row = value; writing = true; audit.push({ table, row: value }); return query
        },
        async single() {
          if (table === 'agent_tasks' && !writing) {
            return { error: null, data: filters.user_id === owner && taskIDs.includes(String(filters.id))
              ? { id: filters.id, repo: 'fixture/repository' } : null }
          }
          return { error: null, data: {
            id: randomUUID(), task_id: taskIDs[0], user_id: owner,
            status: 'running', started_at: new Date().toISOString(), seq: audit.length,
            created_at: new Date().toISOString(), ...row,
          } }
        },
      }
      return query
    },
  } as unknown as SupabaseClient
  return { client, audit }
}

test('real local workspace loop: failing test, read/search, patch, passing test, isolated diff', async t => {
  const owner = randomUUID()
  const taskIDs = [randomUUID(), randomUUID()]
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: process.env.ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION,
    E2B_API_KEY: process.env.E2B_API_KEY,
  }
  Object.assign(process.env, { NODE_ENV: 'test', ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: 'true' })
  delete process.env.E2B_API_KEY
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    // Only this test's generated UUID task directories are removed.
    for (const taskID of taskIDs) {
      rmSync(workspaceRoot(taskID, owner), { recursive: true, force: true })
      rmSync(snapshotDir(taskID, owner), { recursive: true, force: true })
    }
  })
  for (const taskID of taskIDs) {
    const root = workspaceRoot(taskID, owner)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      private: true, scripts: { test: 'node --test sum.test.cjs' },
    }))
    writeFileSync(join(root, 'sum.cjs'), 'module.exports = (a, b) => a - b;\n')
    writeFileSync(join(root, 'sum.test.cjs'), [
      'const test = require("node:test");',
      'const assert = require("node:assert/strict");',
      'test("adds positive values", () => assert.equal(require("./sum.cjs")(2, 3), 5));',
    ].join('\n'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    git(['init', '--initial-branch', 'main'])
    git(['-c', 'user.name=Cloud Code Test', '-c', 'user.email=fixture@example.invalid', 'add', '.'])
    git(['-c', 'user.name=Cloud Code Test', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Test fixture'])
    git(['checkout', '-b', `agent/${taskID}`])
  }
  const [first, second] = taskIDs
  const { client, audit } = auditFixture(owner, taskIDs)
  const failed = await runInWorkspace(client, owner, first, 'npm test')
  assert.equal(failed.exitCode, 1)
  assert.equal(failed.blocked, false)
  assert.match(failed.stdout + failed.stderr, /adds positive values/)
  assert.equal(listWorkspaceFiles(first, owner).ok, true)
  const searched = searchWorkspaceFiles(first, owner, 'a - b')
  assert.equal(searched.ok, true)
  if (searched.ok) assert.match(searched.data.matches.join('\n'), /sum.cjs:1/)
  const source = readWorkspaceFile(first, owner, 'sum.cjs')
  assert.equal(source.ok, true)
  const patch = 'diff --git a/sum.cjs b/sum.cjs\n--- a/sum.cjs\n+++ b/sum.cjs\n@@ -1 +1 @@\n-module.exports = (a, b) => a - b;\n+module.exports = (a, b) => a + b;\n'
  assert.equal(dryRunWorkspacePatch(first, owner, patch).ok, true)
  assert.equal((await applyWorkspacePatch(first, owner, patch)).ok, true)
  const [fixed, untouched] = await Promise.all([
    runInWorkspace(client, owner, first, 'npm test'),
    runInWorkspace(client, owner, second, 'npm test'),
  ])
  assert.equal(fixed.exitCode, 0)
  assert.equal(untouched.exitCode, 1)
  assert.match(getWorkspaceDiff(first, owner), /\+module.exports = .*a \+ b/)
  assert.equal(getWorkspaceDiff(second, owner), '')
  assert.match(readFileSync(join(workspaceRoot(second, owner), 'sum.cjs'), 'utf8'), /a - b/)
  assert.equal((await applyWorkspacePatch(first, owner, patch)).ok, false, 'replaying patch must not mutate twice')
  assert.equal((await runInWorkspace(client, randomUUID(), first, 'npm test')).blocked, true)
  assert.equal((await runInWorkspace(client, owner, first, 'git push origin main')).blocked, true)
  assert.equal(readWorkspaceFile(first, owner, '../other-tenant/file').ok, false)
  assert.ok(audit.some(entry => entry.table === 'agent_tool_calls'))
})
