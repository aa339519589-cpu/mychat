import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCodeApplyRequest, resolveBoundRepository } from '../lib/code-agent/apply-request'

test('code apply request normalizes a valid workspace publish', () => {
  assert.deepEqual(parseCodeApplyRequest({
    repo: 'owner/project',
    taskId: '123e4567-e89b-42d3-a456-426614174000',
    mode: 'workspace_pr',
    actions: [],
  }), {
    repo: 'owner/project',
    taskId: '123e4567-e89b-42d3-a456-426614174000',
    mode: 'workspace_pr',
    actions: [],
    message: '',
  })
})

test('code apply request validates actions before external work', () => {
  assert.throws(
    () => parseCodeApplyRequest({ actions: [{ kind: 'write_file', path: 'index.html' }] }),
    /文件内容无效/,
  )
  assert.throws(
    () => parseCodeApplyRequest({ repo: '../escape', actions: [] }),
    /仓库参数无效/,
  )
  assert.throws(
    () => parseCodeApplyRequest({ actions: [{ kind: 'unknown' }] }),
    /kind 无效/,
  )
  assert.throws(
    () => parseCodeApplyRequest({ actions: [{ kind: 'delete_file', path: '../secret' }] }),
    /path 无效/,
  )
})

test('workspace publishing cannot override the task-bound repository', () => {
  assert.equal(resolveBoundRepository('Owner/Project', 'owner/project'), 'owner/project')
  assert.equal(resolveBoundRepository(null, 'owner/project'), 'owner/project')
  assert.throws(
    () => resolveBoundRepository('attacker/other', 'owner/project'),
    /绑定仓库不一致/,
  )
  assert.throws(() => resolveBoundRepository(null, null), /缺少绑定仓库/)
})
