import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
  atomicWriteJson,
  createEventWriter,
  defaultOutputDirectory,
  digestValue,
  histogramLatencySummary,
  incrementCount,
  newLatencyAccumulator,
  observeLatency,
  optionChoice,
  optionFlag,
  optionInteger,
  optionNumber,
  optionString,
  parseOptions,
  prepareRunDirectory,
  readBoundedJson,
  rejectUnknownOptions,
  runIdentity,
  safeError,
  sleep,
} from '../lib/harness.mjs'
import {
  createMockWorkflowDriver,
  createRealWorkflowDriver,
  isTerminalStatus,
  jobFixture,
  titleFixture,
} from '../lib/workflow-driver.mjs'

const BOOLEAN_OPTIONS = ['--allow-real', '--allow-writes', '--resume', '--help']
const ALLOWED_OPTIONS = [
  ...BOOLEAN_OPTIONS,
  '--mode', '--operation', '--iterations', '--duration-seconds', '--interval-ms',
  '--poll-interval-ms', '--max-polls', '--timeout-ms', '--seed', '--max-error-rate',
  '--max-consecutive-failures', '--fixtures', '--output',
]

function usage() {
  return `Usage: node ops/soak/run.mjs [options]

Every completed iteration is atomically checkpointed. Resume with the same output
directory and immutable configuration; the target may be extended.

  --mode mock|real
  --operation cycle|status|ready
  --iterations 100          Mutually exclusive with --duration-seconds
  --duration-seconds 86400
  --interval-ms 1000
  --poll-interval-ms 1000
  --max-polls 120
  --max-error-rate 0
  --max-consecutive-failures 3
  --fixtures PATH
  --output PATH
  --resume
  --allow-real
  --allow-writes            Required for real cycle mode
`
}

export function parseSoakArguments(argv) {
  const options = parseOptions(argv, BOOLEAN_OPTIONS)
  rejectUnknownOptions(options, ALLOWED_OPTIONS)
  if (optionFlag(options, '--help')) return { help: true }
  const mode = optionChoice(options, '--mode', 'mock', ['mock', 'real'])
  const operation = optionChoice(
    options,
    '--operation',
    mode === 'mock' ? 'cycle' : 'status',
    ['cycle', 'status', 'ready'],
  )
  if (options.has('--iterations') && options.has('--duration-seconds')) {
    throw new Error('--iterations and --duration-seconds are mutually exclusive')
  }
  const target = options.has('--duration-seconds')
    ? { kind: 'duration', value: optionInteger(options, '--duration-seconds', 0, 1, 604_800) }
    : { kind: 'iterations', value: optionInteger(options, '--iterations', 100, 1, 10_000_000) }
  const resume = optionFlag(options, '--resume')
  if (resume && !options.has('--output')) throw new Error('--resume requires an explicit --output directory')
  return {
    help: false,
    mode,
    operation,
    target,
    intervalMs: optionInteger(options, '--interval-ms', mode === 'mock' ? 5 : 1_000, 0, 3_600_000),
    pollIntervalMs: optionInteger(options, '--poll-interval-ms', mode === 'mock' ? 2 : 1_000, 0, 60_000),
    maxPolls: optionInteger(options, '--max-polls', 120, 1, 10_000),
    timeoutMs: optionInteger(options, '--timeout-ms', 10_000, 100, 120_000),
    seed: optionInteger(options, '--seed', 11, 0, 0xffff_ffff),
    maxErrorRate: optionNumber(options, '--max-error-rate', 0, 0, 1),
    maxConsecutiveFailures: optionInteger(options, '--max-consecutive-failures', 3, 1, 10_000),
    fixturesPath: optionString(options, '--fixtures'),
    output: optionString(options, '--output', defaultOutputDirectory('soak')),
    resume,
    allowReal: optionFlag(options, '--allow-real'),
    allowWrites: optionFlag(options, '--allow-writes'),
  }
}

function targetReached(target, checkpoint) {
  return target.kind === 'iterations'
    ? checkpoint.completedIterations >= target.value
    : checkpoint.activeElapsedMs >= target.value * 1_000
}

function counterTotal(value) {
  const counts = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.values(value)
    : []
  if (counts.some(count => !Number.isSafeInteger(count) || count < 0)) return null
  return counts.reduce((total, count) => total + count, 0)
}

function validateCheckpoint(value, configDigest, target) {
  const latency = value.latency
  const expectedBuckets = newLatencyAccumulator().buckets
  const bucketCounts = Array.isArray(latency?.buckets)
    ? latency.buckets.map(bucket => bucket?.count)
    : []
  if (value.schemaVersion !== 1 || value.tool !== 'soak' || value.configDigest !== configDigest
    || typeof value.runId !== 'string' || typeof value.startedAt !== 'string'
    || !Number.isSafeInteger(value.completedIterations) || value.completedIterations < 0
    || !Number.isFinite(value.activeElapsedMs) || value.activeElapsedMs < 0
    || !Number.isSafeInteger(value.succeeded) || !Number.isSafeInteger(value.failed)
    || value.succeeded < 0 || value.failed < 0
    || value.succeeded + value.failed !== value.completedIterations
    || !Number.isSafeInteger(value.maxConsecutiveFailures) || value.maxConsecutiveFailures < 0
    || !value.statusCounts || typeof value.statusCounts !== 'object' || Array.isArray(value.statusCounts)
    || !value.errorCounts || typeof value.errorCounts !== 'object' || Array.isArray(value.errorCounts)
    || counterTotal(value.statusCounts) !== value.succeeded
    || counterTotal(value.errorCounts) !== value.failed
    || !latency || typeof latency !== 'object' || Array.isArray(latency)
    || latency.count !== value.completedIterations
    || !Number.isFinite(latency.sumMs) || latency.sumMs < 0
    || (latency.count === 0 && (latency.minMs !== null || latency.maxMs !== null))
    || (latency.count > 0 && (!Number.isFinite(latency.minMs) || latency.minMs < 0
      || !Number.isFinite(latency.maxMs) || latency.maxMs < latency.minMs))
    || !Array.isArray(latency.buckets) || latency.buckets.length !== expectedBuckets.length
    || latency.buckets.some((bucket, index) => !bucket || typeof bucket !== 'object'
      || bucket.leMs !== expectedBuckets[index].leMs
      || !Number.isSafeInteger(bucket.count) || bucket.count < 0 || bucket.count > latency.count)
    || bucketCounts.some((count, index) => index > 0 && count < bucketCounts[index - 1])
    || latency.buckets.at(-1)?.count !== latency.count) {
    throw new Error('Soak checkpoint is malformed or belongs to a different configuration')
  }
  if (target.kind === 'iterations' && target.value < value.completedIterations) {
    throw new Error('Resume target is below the completed iteration count')
  }
  if (target.kind === 'duration' && target.value * 1_000 < value.activeElapsedMs) {
    throw new Error('Resume target is below the completed active duration')
  }
  return value
}

async function executeSoakIteration(driver, options, index, signal) {
  if (options.operation === 'ready') return driver.ready({ signal })
  if (options.operation === 'status') {
    let executionId
    if (driver.mode === 'mock') {
      executionId = (await driver.start(titleFixture(driver, index, 'soak-status'), { signal })).executionId
    } else {
      executionId = jobFixture(driver, index)
    }
    return driver.status(executionId, { signal })
  }
  const started = await driver.start(
    titleFixture(driver, index, 'soak-cycle', { allowReplay: false }),
    { signal },
  )
  let status = { executionId: started.executionId, status: started.status, terminal: isTerminalStatus(started.status) }
  for (let poll = 0; poll < options.maxPolls && !status.terminal; poll += 1) {
    await sleep(options.pollIntervalMs, signal)
    status = await driver.status(started.executionId, { signal })
  }
  if (!status.terminal) throw new Error('Workflow did not reach a terminal state within the poll budget')
  return status
}

function checkpointDocument(identity, configDigest, state = {}) {
  return {
    schemaVersion: 1,
    tool: 'soak',
    runId: identity.runId,
    startedAt: identity.startedAt,
    configDigest,
    completedIterations: 0,
    activeElapsedMs: 0,
    succeeded: 0,
    failed: 0,
    maxConsecutiveFailures: 0,
    statusCounts: {},
    errorCounts: {},
    latency: newLatencyAccumulator(),
    ...state,
  }
}

export async function runSoak(argv, environment = process.env) {
  const options = parseSoakArguments(argv)
  if (options.help) {
    process.stdout.write(usage())
    return { exitCode: 0, manifest: null }
  }
  const paths = await prepareRunDirectory(options.output, { resume: options.resume })
  const needsWrites = options.operation === 'cycle'
  const driver = options.mode === 'mock'
    ? createMockWorkflowDriver({ seed: options.seed })
    : await createRealWorkflowDriver({ ...options, needsWrites }, environment)
  const immutableConfig = {
    mode: options.mode,
    operation: options.operation,
    targetKind: options.target.kind,
    intervalMs: options.intervalMs,
    pollIntervalMs: options.pollIntervalMs,
    maxPolls: options.maxPolls,
    timeoutMs: options.timeoutMs,
    seed: options.seed,
    maxErrorRate: options.maxErrorRate,
    maxConsecutiveFailures: options.maxConsecutiveFailures,
    target: driver.target,
  }
  const configDigest = digestValue(immutableConfig)
  let identity = runIdentity('soak')
  let checkpoint
  if (options.resume) {
    checkpoint = validateCheckpoint(
      await readBoundedJson(paths.checkpointPath),
      configDigest,
      options.target,
    )
    identity = {
      schemaVersion: 1,
      tool: 'soak',
      runId: checkpoint.runId,
      startedAt: checkpoint.startedAt,
    }
  } else {
    checkpoint = checkpointDocument(identity, configDigest)
  }
  checkpoint.state = 'running'
  checkpoint.finishedAt = null
  await atomicWriteJson(paths.checkpointPath, checkpoint)
  const config = { ...immutableConfig, target: options.target, runtimeTarget: driver.target }
  await atomicWriteJson(paths.manifestPath, {
    ...identity,
    state: 'running',
    resumed: options.resume,
    config,
    configDigest,
    progress: checkpoint,
  })

  const writer = createEventWriter(paths.eventPath)
  const controller = new AbortController()
  let stopping = false
  let stoppedBySignal = null
  const stop = signalName => {
    stopping = true
    stoppedBySignal = signalName
    controller.abort(new Error(`Received ${signalName}`))
  }
  const onSigint = () => stop('SIGINT')
  const onSigterm = () => stop('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  const invocationStartedAt = performance.now()
  const priorActiveElapsedMs = checkpoint.activeElapsedMs
  let consecutiveFailures = 0
  let thresholdReached = false

  try {
    while (!stopping && !targetReached(options.target, checkpoint)) {
      const index = checkpoint.completedIterations
      const startedAt = performance.now()
      let event
      try {
        const result = await executeSoakIteration(driver, options, index, controller.signal)
        const durationMs = performance.now() - startedAt
        observeLatency(checkpoint.latency, durationMs)
        checkpoint.succeeded += 1
        consecutiveFailures = 0
        incrementCount(checkpoint.statusCounts, result.status)
        event = {
          schemaVersion: 1,
          index,
          completedAt: new Date().toISOString(),
          ok: true,
          durationMs,
          status: result.status,
          ...(result.executionId ? { executionId: result.executionId } : {}),
        }
      } catch (error) {
        if (stopping) break
        const durationMs = performance.now() - startedAt
        const failure = safeError(error)
        observeLatency(checkpoint.latency, durationMs)
        checkpoint.failed += 1
        consecutiveFailures += 1
        checkpoint.maxConsecutiveFailures = Math.max(
          checkpoint.maxConsecutiveFailures,
          consecutiveFailures,
        )
        incrementCount(checkpoint.errorCounts, `${failure.name}:${failure.message}`)
        event = {
          schemaVersion: 1,
          index,
          completedAt: new Date().toISOString(),
          ok: false,
          durationMs,
          error: failure,
        }
      }
      checkpoint.completedIterations += 1
      checkpoint.activeElapsedMs = priorActiveElapsedMs + (performance.now() - invocationStartedAt)
      checkpoint.lastCompletedAt = new Date().toISOString()
      await writer.write(event)
      await atomicWriteJson(paths.checkpointPath, checkpoint)
      if (consecutiveFailures >= options.maxConsecutiveFailures) {
        thresholdReached = true
        break
      }
      if (!targetReached(options.target, checkpoint) && options.intervalMs > 0) {
        try {
          await sleep(options.intervalMs, controller.signal)
        } catch {
          if (!stopping) throw new Error('Soak interval was interrupted unexpectedly')
        }
        checkpoint.activeElapsedMs = priorActiveElapsedMs + (performance.now() - invocationStartedAt)
        await atomicWriteJson(paths.checkpointPath, checkpoint)
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
    await writer.close()
  }

  const attempted = checkpoint.succeeded + checkpoint.failed
  const errorRate = attempted === 0 ? 0 : checkpoint.failed / attempted
  const completed = targetReached(options.target, checkpoint)
  const state = thresholdReached || (completed && errorRate > options.maxErrorRate)
    ? 'failed'
    : completed ? 'completed' : 'interrupted'
  checkpoint.state = state
  checkpoint.finishedAt = state === 'completed' || state === 'failed' ? new Date().toISOString() : null
  await atomicWriteJson(paths.checkpointPath, checkpoint)
  const manifest = {
    ...identity,
    finishedAt: new Date().toISOString(),
    state,
    resumed: options.resume,
    ...(stoppedBySignal ? { stoppedBySignal } : {}),
    config,
    configDigest,
    summary: {
      completedIterations: checkpoint.completedIterations,
      activeElapsedMs: checkpoint.activeElapsedMs,
      succeeded: checkpoint.succeeded,
      failed: checkpoint.failed,
      errorRate,
      maxConsecutiveFailures: checkpoint.maxConsecutiveFailures,
      statusCounts: checkpoint.statusCounts,
      errorCounts: checkpoint.errorCounts,
      latency: histogramLatencySummary(checkpoint.latency),
    },
  }
  await atomicWriteJson(paths.manifestPath, manifest)
  process.stdout.write(`Soak ${state}: ${checkpoint.completedIterations} iterations checkpointed; results: ${paths.output}\n`)
  return { exitCode: state === 'completed' ? 0 : state === 'interrupted' ? 130 : 1, manifest }
}

async function main() {
  const result = await runSoak(process.argv.slice(2))
  process.exitCode = result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`Soak failed: ${safeError(error).message}\n`)
    process.exitCode = 1
  })
}
