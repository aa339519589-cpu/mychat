import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import {
  atomicWriteJson,
  createEventWriter,
  defaultOutputDirectory,
  digestValue,
  optionChoice,
  optionFlag,
  optionInteger,
  optionString,
  parseOptions,
  prepareRunDirectory,
  rejectUnknownOptions,
  runIdentity,
  safeError,
} from '../lib/harness.mjs'
import {
  createMockWorkflowDriver,
  createRealWorkflowDriver,
  jobFixture,
  titleFixture,
} from '../lib/workflow-driver.mjs'

const ALL_SCENARIOS = ['duplicate-start', 'cancel-race', 'poll-abort-recovery', 'dependency-outage']
const WRITE_SCENARIOS = new Set(['duplicate-start', 'cancel-race'])
const BOOLEAN_OPTIONS = ['--allow-real', '--allow-writes', '--help']
const ALLOWED_OPTIONS = [
  ...BOOLEAN_OPTIONS,
  '--mode', '--scenarios', '--repetitions', '--timeout-ms', '--seed', '--fixtures', '--output',
]

function usage() {
  return `Usage: node ops/chaos/run.mjs [options]

Mock mode covers all deterministic scenarios. Real mode injects client-side faults
against staging only; it never installs a remote fault backdoor.

  --mode mock|real
  --scenarios duplicate-start,cancel-race,poll-abort-recovery,dependency-outage
  --repetitions 10
  --fixtures PATH
  --output PATH
  --allow-real
  --allow-writes           Required for duplicate-start and cancel-race in real mode
`
}

function scenarioList(raw) {
  const scenarios = raw.split(',').map(value => value.trim()).filter(Boolean)
  if (scenarios.length < 1 || new Set(scenarios).size !== scenarios.length
    || scenarios.some(value => !ALL_SCENARIOS.includes(value))) {
    throw new Error(`--scenarios must contain unique values from: ${ALL_SCENARIOS.join(', ')}`)
  }
  return scenarios
}

export function parseChaosArguments(argv) {
  const options = parseOptions(argv, BOOLEAN_OPTIONS)
  rejectUnknownOptions(options, ALLOWED_OPTIONS)
  if (optionFlag(options, '--help')) return { help: true }
  const mode = optionChoice(options, '--mode', 'mock', ['mock', 'real'])
  const defaults = mode === 'mock' ? ALL_SCENARIOS.join(',') : 'poll-abort-recovery'
  const scenarios = scenarioList(optionString(options, '--scenarios', defaults))
  if (mode === 'real' && scenarios.includes('dependency-outage')) {
    throw new Error('dependency-outage is mock-only; infrastructure faults require an external staging orchestrator')
  }
  return {
    help: false,
    mode,
    scenarios,
    repetitions: optionInteger(options, '--repetitions', 10, 1, 1_000),
    timeoutMs: optionInteger(options, '--timeout-ms', 10_000, 100, 120_000),
    seed: optionInteger(options, '--seed', 7, 0, 0xffff_ffff),
    fixturesPath: optionString(options, '--fixtures'),
    output: optionString(options, '--output', defaultOutputDirectory('chaos')),
    allowReal: optionFlag(options, '--allow-real'),
    allowWrites: optionFlag(options, '--allow-writes'),
  }
}

function assertInvariant(condition, message) {
  if (!condition) throw new Error(`Chaos invariant failed: ${message}`)
}

async function duplicateStart(driver, fixtureIndex) {
  const fixture = titleFixture(driver, fixtureIndex, 'chaos-duplicate', { allowReplay: true })
  const results = await Promise.all([driver.start(fixture), driver.start(fixture)])
  assertInvariant(results[0].executionId === results[1].executionId, 'duplicate starts diverged')
  assertInvariant(results.filter(result => result.created).length <= 1, 'duplicate starts created multiple executions')
  return {
    executionId: results[0].executionId,
    createdCount: results.filter(result => result.created).length,
    statuses: results.map(result => result.status),
  }
}

async function cancelRace(driver, fixtureIndex) {
  const fixture = titleFixture(driver, fixtureIndex, 'chaos-cancel', { allowReplay: true })
  const started = await driver.start(fixture)
  const cancellations = await Promise.all([
    driver.cancel(started.executionId),
    driver.cancel(started.executionId),
  ])
  const status = await driver.status(started.executionId)
  assertInvariant(cancellations.every(result => result.executionId === started.executionId), 'cancel identity changed')
  assertInvariant(status.executionId === started.executionId, 'status identity changed after cancel')
  return {
    executionId: started.executionId,
    cancellationStatuses: cancellations.map(result => result.status),
    finalStatus: status.status,
  }
}

async function pollAbortRecovery(driver, fixtureIndex) {
  let executionId
  if (driver.mode === 'mock') {
    executionId = (await driver.start(titleFixture(driver, fixtureIndex, 'chaos-abort'))).executionId
  } else {
    executionId = jobFixture(driver, fixtureIndex)
  }
  const controller = new AbortController()
  controller.abort(new Error('intentional staging client abort'))
  let aborted = false
  try {
    await driver.status(executionId, { signal: controller.signal })
  } catch {
    aborted = true
  }
  assertInvariant(aborted, 'aborted status request unexpectedly completed')
  const recovered = await driver.status(executionId)
  assertInvariant(recovered.executionId === executionId, 'status did not recover after client abort')
  return { executionId, recoveredStatus: recovered.status }
}

async function dependencyOutage(driver, fixtureIndex) {
  const started = await driver.start(titleFixture(driver, fixtureIndex, 'chaos-outage'))
  driver.injectFailures('status', 1)
  let failedClosed = false
  try {
    await driver.status(started.executionId)
  } catch {
    failedClosed = true
  }
  assertInvariant(failedClosed, 'injected dependency outage was not observed')
  const recovered = await driver.status(started.executionId)
  assertInvariant(recovered.executionId === started.executionId, 'execution identity changed after outage')
  return { executionId: started.executionId, recoveredStatus: recovered.status }
}

const SCENARIOS = {
  'duplicate-start': duplicateStart,
  'cancel-race': cancelRace,
  'poll-abort-recovery': pollAbortRecovery,
  'dependency-outage': dependencyOutage,
}

export async function runChaos(argv, environment = process.env) {
  const options = parseChaosArguments(argv)
  if (options.help) {
    process.stdout.write(usage())
    return { exitCode: 0, manifest: null }
  }
  const paths = await prepareRunDirectory(options.output)
  const identity = runIdentity('chaos')
  const needsWrites = options.scenarios.some(name => WRITE_SCENARIOS.has(name))
  const driver = options.mode === 'mock'
    ? createMockWorkflowDriver({ seed: options.seed })
    : await createRealWorkflowDriver({ ...options, needsWrites }, environment)
  const config = {
    mode: options.mode,
    scenarios: options.scenarios,
    repetitions: options.repetitions,
    timeoutMs: options.timeoutMs,
    seed: options.seed,
    target: driver.target,
  }
  const configDigest = digestValue(config)
  await atomicWriteJson(paths.manifestPath, { ...identity, state: 'running', config, configDigest })
  const writer = createEventWriter(paths.eventPath)
  let passed = 0
  let failed = 0
  const failures = {}
  let fixtureIndex = 0

  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    for (const scenario of options.scenarios) {
      const startedAt = performance.now()
      try {
        const detail = await SCENARIOS[scenario](driver, fixtureIndex)
        passed += 1
        await writer.write({
          schemaVersion: 1,
          repetition,
          scenario,
          completedAt: new Date().toISOString(),
          ok: true,
          durationMs: performance.now() - startedAt,
          detail,
        })
      } catch (error) {
        failed += 1
        const failure = safeError(error)
        failures[`${scenario}:${failure.name}:${failure.message}`] =
          (failures[`${scenario}:${failure.name}:${failure.message}`] ?? 0) + 1
        await writer.write({
          schemaVersion: 1,
          repetition,
          scenario,
          completedAt: new Date().toISOString(),
          ok: false,
          durationMs: performance.now() - startedAt,
          error: failure,
        })
      }
      fixtureIndex += 1
    }
  }
  await writer.close()
  const state = failed === 0 ? 'completed' : 'failed'
  const manifest = {
    ...identity,
    finishedAt: new Date().toISOString(),
    state,
    config,
    configDigest,
    summary: { attempted: passed + failed, passed, failed, failures },
  }
  await atomicWriteJson(paths.manifestPath, manifest)
  process.stdout.write(`Chaos ${state}: ${passed}/${passed + failed} invariants passed; results: ${paths.output}\n`)
  return { exitCode: failed === 0 ? 0 : 1, manifest }
}

async function main() {
  const result = await runChaos(process.argv.slice(2))
  process.exitCode = result.exitCode
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`Chaos failed: ${safeError(error).message}\n`)
    process.exitCode = 1
  })
}
