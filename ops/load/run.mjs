import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
  atomicWriteJson,
  createEventWriter,
  defaultOutputDirectory,
  digestValue,
  exactLatencySummary,
  incrementCount,
  optionChoice,
  optionFlag,
  optionInteger,
  optionNumber,
  optionString,
  parseOptions,
  prepareRunDirectory,
  rejectUnknownOptions,
  runIdentity,
  runWithConcurrency,
  safeError,
  sleep,
} from '../lib/harness.mjs'
import {
  createMockWorkflowDriver,
  createRealWorkflowDriver,
  jobFixture,
  titleFixture,
} from '../lib/workflow-driver.mjs'

const BOOLEAN_OPTIONS = ['--allow-real', '--allow-writes', '--allow-replay', '--help']
const ALLOWED_OPTIONS = [
  ...BOOLEAN_OPTIONS,
  '--mode', '--operation', '--requests', '--concurrency', '--rate', '--timeout-ms',
  '--seed', '--max-error-rate', '--fixtures', '--output',
]

function usage() {
  return `Usage: node ops/load/run.mjs [options]

Defaults to a bounded mock title workload. Real mode is staging-only.

  --mode mock|real
  --operation title|status|ready
  --requests 100
  --concurrency 10
  --rate 0                 Requests/second; 0 means no pacing
  --timeout-ms 10000
  --max-error-rate 0
  --fixtures PATH          Required for real title/status operations
  --output PATH
  --allow-replay           Allow real title fixtures to be reused
  --allow-real             Required with real mode
  --allow-writes           Required for real title starts
`
}

export function parseLoadArguments(argv) {
  const options = parseOptions(argv, BOOLEAN_OPTIONS)
  rejectUnknownOptions(options, ALLOWED_OPTIONS)
  if (optionFlag(options, '--help')) return { help: true }
  const mode = optionChoice(options, '--mode', 'mock', ['mock', 'real'])
  const operation = optionChoice(
    options,
    '--operation',
    mode === 'mock' ? 'title' : 'status',
    ['title', 'status', 'ready'],
  )
  return {
    help: false,
    mode,
    operation,
    requests: optionInteger(options, '--requests', 100, 1, 50_000),
    concurrency: optionInteger(options, '--concurrency', 10, 1, 256),
    rate: optionNumber(options, '--rate', 0, 0, 10_000),
    timeoutMs: optionInteger(options, '--timeout-ms', 10_000, 100, 120_000),
    seed: optionInteger(options, '--seed', 1, 0, 0xffff_ffff),
    maxErrorRate: optionNumber(options, '--max-error-rate', 0, 0, 1),
    fixturesPath: optionString(options, '--fixtures'),
    output: optionString(options, '--output', defaultOutputDirectory('load')),
    allowReplay: optionFlag(options, '--allow-replay'),
    allowReal: optionFlag(options, '--allow-real'),
    allowWrites: optionFlag(options, '--allow-writes'),
  }
}

async function execute(driver, operation, index, mockStatusIds, allowReplay) {
  if (operation === 'ready') return driver.ready()
  if (operation === 'title') {
    return driver.start(titleFixture(driver, index, 'load', { allowReplay }))
  }
  const executionId = driver.mode === 'mock' ? mockStatusIds[index] : jobFixture(driver, index)
  return driver.status(executionId)
}

export async function runLoad(argv, environment = process.env) {
  const options = parseLoadArguments(argv)
  if (options.help) {
    process.stdout.write(usage())
    return { exitCode: 0, manifest: null }
  }
  const paths = await prepareRunDirectory(options.output)
  const identity = runIdentity('load')
  const needsWrites = options.operation === 'title'
  const driver = options.mode === 'mock'
    ? createMockWorkflowDriver({ seed: options.seed })
    : await createRealWorkflowDriver({ ...options, needsWrites }, environment)
  if (options.mode === 'real' && options.operation === 'title'
    && !options.allowReplay && driver.fixtures.titleRequests.length < options.requests) {
    throw new Error('Real title load requires one unique fixture per request unless --allow-replay is set')
  }

  const mockStatusIds = []
  if (options.mode === 'mock' && options.operation === 'status') {
    await runWithConcurrency(options.requests, options.concurrency, async index => {
      const started = await driver.start(titleFixture(driver, index, 'load-status'))
      mockStatusIds[index] = started.executionId
    })
  }
  const config = {
    mode: options.mode,
    operation: options.operation,
    requests: options.requests,
    concurrency: options.concurrency,
    ratePerSecond: options.rate,
    timeoutMs: options.timeoutMs,
    seed: options.seed,
    maxErrorRate: options.maxErrorRate,
    allowReplay: options.allowReplay,
    target: driver.target,
  }
  const configDigest = digestValue(config)
  await atomicWriteJson(paths.manifestPath, {
    ...identity,
    state: 'running',
    config,
    configDigest,
  })

  const writer = createEventWriter(paths.eventPath)
  const latencies = []
  const statusCounts = {}
  const errorCounts = {}
  let succeeded = 0
  let failed = 0
  const benchmarkStartedAt = performance.now()

  await runWithConcurrency(options.requests, options.concurrency, async index => {
    if (options.rate > 0) {
      const scheduledAt = benchmarkStartedAt + (index * 1_000 / options.rate)
      await sleep(Math.max(0, scheduledAt - performance.now()))
    }
    const startedAt = performance.now()
    try {
      const result = await execute(driver, options.operation, index, mockStatusIds, options.allowReplay)
      const durationMs = performance.now() - startedAt
      latencies.push(durationMs)
      succeeded += 1
      incrementCount(statusCounts, result.status)
      await writer.write({
        schemaVersion: 1,
        index,
        completedAt: new Date().toISOString(),
        ok: true,
        durationMs,
        status: result.status,
        ...(result.executionId ? { executionId: result.executionId } : {}),
        ...(typeof result.created === 'boolean' ? { created: result.created } : {}),
      })
    } catch (error) {
      const durationMs = performance.now() - startedAt
      const failure = safeError(error)
      latencies.push(durationMs)
      failed += 1
      incrementCount(errorCounts, `${failure.name}:${failure.message}`)
      await writer.write({
        schemaVersion: 1,
        index,
        completedAt: new Date().toISOString(),
        ok: false,
        durationMs,
        error: failure,
      })
    }
  })
  await writer.close()

  const durationMs = performance.now() - benchmarkStartedAt
  const errorRate = failed / options.requests
  const state = errorRate <= options.maxErrorRate ? 'completed' : 'failed'
  const manifest = {
    ...identity,
    finishedAt: new Date().toISOString(),
    state,
    config,
    configDigest,
    summary: {
      attempted: options.requests,
      succeeded,
      failed,
      errorRate,
      durationMs,
      effectiveRequestsPerSecond: options.requests / Math.max(durationMs / 1_000, 0.001),
      latency: exactLatencySummary(latencies),
      statusCounts,
      errorCounts,
    },
  }
  await atomicWriteJson(paths.manifestPath, manifest)
  process.stdout.write(`Load ${state}: ${succeeded}/${options.requests} succeeded; results: ${paths.output}\n`)
  return { exitCode: state === 'completed' ? 0 : 1, manifest }
}

async function main() {
  const result = await runLoad(process.argv.slice(2))
  process.exitCode = result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`Load failed: ${safeError(error).message}\n`)
    process.exitCode = 1
  })
}
