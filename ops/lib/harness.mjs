import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleepTimer } from 'node:timers/promises'

const SECRET_PATTERN = /(authorization|bearer|cookie|token|secret|password)=?\s*[^\s,;]+/gi
const URL_PATTERN = /https?:\/\/[^\s]+/gi
const HISTOGRAM_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000]

export function parseOptions(argv, booleanNames = []) {
  const booleans = new Set(booleanNames)
  const options = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!name?.startsWith('--') || name === '--' || options.has(name)) {
      throw new Error('Invalid or duplicate command option')
    }
    if (booleans.has(name)) {
      options.set(name, true)
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
    options.set(name, value)
    index += 1
  }
  return options
}

export function rejectUnknownOptions(options, allowed) {
  const names = new Set(allowed)
  if ([...options.keys()].some(name => !names.has(name))) throw new Error('Unknown command option')
}

export function optionString(options, name, fallback = '') {
  const value = options.get(name)
  return typeof value === 'string' ? value : fallback
}

export function optionFlag(options, name) {
  return options.get(name) === true
}

export function optionInteger(options, name, fallback, minimum, maximum) {
  const raw = optionString(options, name, String(fallback))
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function optionNumber(options, name, fallback, minimum, maximum) {
  const raw = optionString(options, name, String(fallback))
  const value = Number(raw)
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

export function optionChoice(options, name, fallback, choices) {
  const value = optionString(options, name, fallback)
  if (!choices.includes(value)) throw new Error(`${name} must be one of: ${choices.join(', ')}`)
  return value
}

export function defaultOutputDirectory(tool, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return resolve('.artifacts', 'ops', `${tool}-${stamp}-${process.pid}`)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false
    throw error
  }
}

export async function prepareRunDirectory(directory, { resume = false } = {}) {
  const output = resolve(directory)
  await mkdir(output, { recursive: true })
  const manifestPath = resolve(output, 'manifest.json')
  const checkpointPath = resolve(output, 'checkpoint.json')
  const eventPath = resolve(output, 'events.jsonl')
  const occupied = await Promise.all([manifestPath, checkpointPath, eventPath].map(exists))
  if (!resume && occupied.some(Boolean)) {
    throw new Error('Output directory already contains run data')
  }
  if (resume && !(await exists(checkpointPath))) {
    throw new Error('Resume requires an existing checkpoint.json')
  }
  return { output, manifestPath, checkpointPath, eventPath }
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, path)
}

export async function readBoundedJson(path, maxBytes = 1_048_576) {
  const metadata = await stat(path)
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > maxBytes) {
    throw new Error('JSON input file has an invalid size')
  }
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON input must contain an object')
  }
  return value
}

export function createEventWriter(path) {
  let pending = Promise.resolve()
  return {
    write(value) {
      pending = pending.then(() => appendFile(path, `${JSON.stringify(value)}\n`, 'utf8'))
      return pending
    },
    close() {
      return pending
    },
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
}

export function digestValue(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')
}

export function safeError(error) {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : 'Error'
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw
    .replace(URL_PATTERN, '[url]')
    .replace(SECRET_PATTERN, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 240)
  return { name, message }
}

export function createSeededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

export async function sleep(milliseconds, signal) {
  if (milliseconds <= 0) return
  await sleepTimer(milliseconds, undefined, signal ? { signal } : undefined)
}

export async function runWithConcurrency(total, concurrency, operation) {
  let next = 0
  async function worker() {
    while (true) {
      const index = next
      next += 1
      if (index >= total) return
      await operation(index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(total, concurrency) }, () => worker()))
}

export function percentile(values, fraction) {
  if (values.length === 0) return null
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]
}

export function exactLatencySummary(values) {
  if (values.length === 0) return { count: 0, minMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, meanMs: null }
  const sum = values.reduce((total, value) => total + value, 0)
  return {
    count: values.length,
    minMs: Math.min(...values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: Math.max(...values),
    meanMs: sum / values.length,
  }
}

export function newLatencyAccumulator() {
  return {
    count: 0,
    sumMs: 0,
    minMs: null,
    maxMs: null,
    buckets: [...HISTOGRAM_BOUNDS_MS.map(leMs => ({ leMs, count: 0 })), { leMs: null, count: 0 }],
  }
}

export function observeLatency(accumulator, value) {
  accumulator.count += 1
  accumulator.sumMs += value
  accumulator.minMs = accumulator.minMs === null ? value : Math.min(accumulator.minMs, value)
  accumulator.maxMs = accumulator.maxMs === null ? value : Math.max(accumulator.maxMs, value)
  for (const bucket of accumulator.buckets) {
    if (bucket.leMs === null || value <= bucket.leMs) bucket.count += 1
  }
}

function histogramPercentile(accumulator, fraction) {
  if (accumulator.count === 0) return null
  const target = Math.ceil(accumulator.count * fraction)
  const bucket = accumulator.buckets.find(candidate => candidate.count >= target)
  return bucket?.leMs ?? accumulator.maxMs
}

export function histogramLatencySummary(accumulator) {
  return {
    count: accumulator.count,
    minMs: accumulator.minMs,
    p50UpperBoundMs: histogramPercentile(accumulator, 0.5),
    p95UpperBoundMs: histogramPercentile(accumulator, 0.95),
    p99UpperBoundMs: histogramPercentile(accumulator, 0.99),
    maxMs: accumulator.maxMs,
    meanMs: accumulator.count === 0 ? null : accumulator.sumMs / accumulator.count,
    buckets: accumulator.buckets,
  }
}

export function incrementCount(record, name) {
  record[name] = (record[name] ?? 0) + 1
}

export function runIdentity(tool) {
  return { schemaVersion: 1, tool, runId: randomUUID(), startedAt: new Date().toISOString() }
}
