import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { detectProjectCommands } from '../lib/agent/project-detect'
import { workspaceRoot } from '../lib/agent/workspace'

function project(t: test.TestContext, files: Record<string, string>) {
  const taskId = `detect-${crypto.randomUUID()}`
  const userId = `user-${crypto.randomUUID()}`
  const root = workspaceRoot(taskId, userId)
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const segments = path.split('/')
    segments.pop()
    if (segments.length) mkdirSync(`${root}/${segments.join('/')}`, { recursive: true })
    writeFileSync(`${root}/${path}`, content)
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return detectProjectCommands(taskId, userId)
}

test('project detection honors the declared manager and script-backed Next commands', t => {
  const detected = project(t, {
    'package.json': JSON.stringify({
      packageManager: 'pnpm@10.0.0',
      dependencies: { next: '16.0.0', react: '19.0.0' },
      devDependencies: { typescript: '5.7.0' },
      scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'node --test', build: 'next build' },
    }),
    'tsconfig.json': '{}',
  })
  assert.equal(detected.packageManager, 'pnpm')
  assert.equal(detected.framework, 'next')
  assert.equal(detected.installCommand, 'pnpm install --ignore-scripts')
  assert.equal(detected.lintCommand, 'pnpm lint')
  assert.equal(detected.typecheckCommand, 'pnpm typecheck')
  assert.equal(detected.testCommand, 'pnpm test')
  assert.equal(detected.buildCommand, 'pnpm build')
  assert.equal(detected.confidence, 100)
})

test('lockfiles take precedence and an installed workspace skips dependency installation', t => {
  const detected = project(t, {
    'package.json': JSON.stringify({ packageManager: 'yarn@4.0.0' }),
    'bun.lock': '',
    'node_modules/.keep': '',
  })
  assert.equal(detected.packageManager, 'bun')
  assert.equal(detected.installCommand, null)
})

test('test fallback distinguishes Jest from Vitest configuration', async t => {
  await t.test('jest', nested => {
    const detected = project(nested, {
      'package.json': '{}',
      'jest.config.cjs': 'module.exports = {}',
    })
    assert.equal(detected.testCommand, 'npx jest --runInBand')
    assert.match(detected.notes.join('\n'), /jest --runInBand/)
  })
  await t.test('vitest', nested => {
    const detected = project(nested, {
      'package.json': '{}',
      'vitest.config.mts': 'export default {}',
    })
    assert.equal(detected.testCommand, 'npx vitest run')
    assert.match(detected.notes.join('\n'), /vitest run/)
  })
})
