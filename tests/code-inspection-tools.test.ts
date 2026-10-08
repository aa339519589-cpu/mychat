import assert from 'node:assert/strict'
import test from 'node:test'
import { codeLineRange, workspaceGlob } from '../lib/code-tools/inspection-handlers'
import { buildCodeTools } from '../lib/code-tools/definitions'

test('cloud file globs match root and nested files without escaping workspace', () => {
  const matcher = workspaceGlob('**/*.ts')
  assert.equal(matcher.test('index.ts'), true)
  assert.equal(matcher.test('src/lib/index.ts'), true)
  assert.equal(matcher.test('src/index.swift'), false)
  assert.equal(workspaceGlob('src/a?.ts').test('src/ab.ts'), true)
  assert.throws(() => workspaceGlob('../secret'), /相对/)
  assert.throws(() => workspaceGlob('/etc/passwd'), /相对/)
})

test('line reads preserve actual numbering and bound output', () => {
  assert.equal(codeLineRange('one\ntwo\nthree', 2, 1), '总计 3 行；本次第 2–2 行\n2: two')
  assert.ok(codeLineRange('a'.repeat(60_000), 1, 1).length < 2_100)
  assert.ok(codeLineRange('one\ntwo', Number.NaN, Number.NaN).includes('1: one'))
})

test('cloud runtime tools are exposed only when executable workspace is available', () => {
  const available = buildCodeTools({ isWorkspace: true, canExecute: true, executePermission: '云端隔离执行' })
    .map(tool => tool.function.name)
  for (const name of ['find_files', 'read_file_lines', 'inspect_environment', 'git_status', 'execute']) {
    assert.ok(available.includes(name))
  }
  const disabled = buildCodeTools({ isWorkspace: true, canExecute: false, executePermission: '禁用' })
    .map(tool => tool.function.name)
  assert.equal(disabled.includes('inspect_environment'), false)
  assert.equal(disabled.includes('git_status'), false)
})
