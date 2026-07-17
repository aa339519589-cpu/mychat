import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'

const root = process.cwd()

function temporaryDirectory(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mychat-ops-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function run(script: string, args: string[]) {
  return execFileSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
  })
}

function json(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

test('mock load writes bounded per-request evidence and a passing manifest', t => {
  const output = join(temporaryDirectory(t), 'load')
  run('ops/load/run.mjs', [
    '--mode', 'mock', '--operation', 'title', '--requests', '12',
    '--concurrency', '3', '--output', output,
  ])

  const manifest = json(join(output, 'manifest.json'))
  const summary = manifest.summary as Record<string, unknown>
  assert.equal(manifest.state, 'completed')
  assert.equal(summary.attempted, 12)
  assert.equal(summary.succeeded, 12)
  assert.equal(readFileSync(join(output, 'events.jsonl'), 'utf8').trim().split('\n').length, 12)
})

test('mock chaos exercises every supported invariant', t => {
  const output = join(temporaryDirectory(t), 'chaos')
  run('ops/chaos/run.mjs', ['--mode', 'mock', '--repetitions', '2', '--output', output])

  const manifest = json(join(output, 'manifest.json'))
  const summary = manifest.summary as Record<string, unknown>
  assert.equal(manifest.state, 'completed')
  assert.equal(summary.attempted, 8)
  assert.equal(summary.failed, 0)
})

test('mock soak resumes the same run and extends its checkpoint target', t => {
  const output = join(temporaryDirectory(t), 'soak')
  run('ops/soak/run.mjs', ['--mode', 'mock', '--iterations', '3', '--output', output])
  const first = json(join(output, 'manifest.json'))
  run('ops/soak/run.mjs', [
    '--mode', 'mock', '--iterations', '5', '--output', output, '--resume',
  ])

  const resumed = json(join(output, 'manifest.json'))
  const checkpoint = json(join(output, 'checkpoint.json'))
  assert.equal(resumed.runId, first.runId)
  assert.equal(resumed.state, 'completed')
  assert.equal(checkpoint.completedIterations, 5)
  assert.equal(readFileSync(join(output, 'events.jsonl'), 'utf8').trim().split('\n').length, 5)

  checkpoint.completedIterations = 4
  writeFileSync(join(output, 'checkpoint.json'), JSON.stringify(checkpoint))
  const corruptResume = spawnSync(process.execPath, [
    resolve(root, 'ops/soak/run.mjs'),
    '--mode', 'mock', '--iterations', '6', '--output', output, '--resume',
  ], { cwd: root, encoding: 'utf8', timeout: 15_000 })
  assert.equal(corruptResume.status, 1)
  assert.match(corruptResume.stderr, /checkpoint is malformed/i)
})

test('real mode permanently rejects the known production host', t => {
  const directory = temporaryDirectory(t)
  const missingAcknowledgement = spawnSync(process.execPath, [
    resolve(root, 'ops/load/run.mjs'),
    '--mode', 'real', '--operation', 'ready', '--requests', '1',
    '--allow-real', '--output', join(directory, 'unacknowledged'),
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      MYCHAT_OPS_ENVIRONMENT: '',
      MYCHAT_OPS_REAL_ACK: '',
      MYCHAT_OPS_BASE_URL: 'http://127.0.0.1:9',
    },
  })
  assert.equal(missingAcknowledgement.status, 1)
  assert.match(missingAcknowledgement.stderr, /explicit staging acknowledgements/i)

  const output = join(directory, 'blocked')
  const result = spawnSync(process.execPath, [
    resolve(root, 'ops/load/run.mjs'),
    '--mode', 'real', '--operation', 'ready', '--requests', '1',
    '--allow-real', '--output', output,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      MYCHAT_OPS_ENVIRONMENT: 'staging',
      MYCHAT_OPS_REAL_ACK: 'staging-only',
      MYCHAT_OPS_BASE_URL: 'https://mychat-nm6x.onrender.com',
      MYCHAT_OPS_ALLOWED_HOST: 'mychat-nm6x.onrender.com',
      MYCHAT_OPS_EXPECTED_REVISION: 'daacffad107a',
    },
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /production host is permanently blocked/i)
})

test('ops commands are quality-gated and generated evidence is ignored', () => {
  const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8')
  const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8')
  const documentation = readFileSync(resolve(root, 'ops/README.md'), 'utf8')
  for (const command of ['ops:load', 'ops:chaos', 'ops:soak']) {
    assert.match(packageJson, new RegExp(`"${command}"`))
  }
  assert.match(packageJson, /"lint":\s*"[^"]*\bops\b/)
  assert.match(ignore, /^\.artifacts\/$/m)
  assert.match(documentation, /MYCHAT_OPS_REAL_ACK=staging-only/)
  assert.match(documentation, /does not expose an HTTP chaos backdoor/)
})
