import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { validateReadyPayload } from '../../scripts/check-production-health.mjs'
import { createSeededRandom, digestValue, readBoundedJson, sleep } from './harness.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const JOB_STATUS = new Set([
  'queued', 'running', 'retry_wait', 'awaiting_input', 'cancelling',
  'completed', 'failed', 'cancelled',
])
const PRODUCTION_HOSTS = new Set(['mychat-nm6x.onrender.com'])

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function normalizeBaseUrl(raw, environment) {
  const url = new URL(raw)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Real target must be an HTTPS origin, or an HTTP loopback origin')
  }
  if (PRODUCTION_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('The production host is permanently blocked by ops tooling')
  }
  const allowedHost = environment.MYCHAT_OPS_ALLOWED_HOST?.trim().toLowerCase() ?? ''
  if (!loopback && allowedHost !== url.host.toLowerCase()) {
    throw new Error('MYCHAT_OPS_ALLOWED_HOST must exactly match the staging target host')
  }
  return url
}

function assertRealAuthorization(options, environment) {
  if (!options.allowReal || environment.MYCHAT_OPS_REAL_ACK !== 'staging-only'
    || environment.MYCHAT_OPS_ENVIRONMENT !== 'staging') {
    throw new Error('Real mode requires --allow-real and explicit staging acknowledgements')
  }
  if (options.needsWrites && (!options.allowWrites
    || environment.MYCHAT_OPS_WRITE_ACK !== 'disposable-staging-data')) {
    throw new Error('Real writes require --allow-writes and a disposable staging data acknowledgement')
  }
}

function assertTitleRequest(value) {
  const request = objectOf(value)
  if (!request || typeof request.conversationId !== 'string' || !UUID.test(request.conversationId)) {
    throw new Error('Title fixture has an invalid conversationId')
  }
  for (const field of ['userText', 'assistantText']) {
    if (typeof request[field] !== 'string' || request[field].length < 1 || request[field].length > 2_000) {
      throw new Error(`Title fixture has an invalid ${field}`)
    }
  }
  if (request.endpointId !== undefined
    && (typeof request.endpointId !== 'string' || !UUID.test(request.endpointId))) {
    throw new Error('Title fixture has an invalid endpointId')
  }
  return {
    conversationId: request.conversationId,
    userText: request.userText,
    assistantText: request.assistantText,
    ...(request.endpointId ? { endpointId: request.endpointId } : {}),
  }
}

export async function loadStagingFixtures(path, expectedHost) {
  if (!path) throw new Error('Real workflow operations require --fixtures')
  const document = await readBoundedJson(resolve(path))
  if (document.schemaVersion !== 1 || document.environment !== 'staging'
    || document.targetHost !== expectedHost) {
    throw new Error('Fixture file is not bound to this staging target')
  }
  const titleRequests = Array.isArray(document.titleRequests)
    ? document.titleRequests.map(assertTitleRequest)
    : []
  const jobIds = Array.isArray(document.jobIds) ? document.jobIds : []
  if (jobIds.some(value => typeof value !== 'string' || !UUID.test(value))) {
    throw new Error('Fixture file contains an invalid jobId')
  }
  return {
    titleRequests,
    jobIds: [...jobIds],
    digest: digestValue({
      schemaVersion: document.schemaVersion,
      environment: document.environment,
      targetHost: document.targetHost,
      titleRequests,
      jobIds,
    }),
  }
}

async function boundedResponseJson(response, operation, maximumBytes = 65_536) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error(`${operation} returned an oversized response`)
  }
  const body = await response.arrayBuffer()
  if (body.byteLength > maximumBytes) throw new Error(`${operation} returned an oversized response`)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('application/json')) throw new Error(`${operation} did not return JSON`)
  try {
    return JSON.parse(Buffer.from(body).toString('utf8'))
  } catch {
    throw new Error(`${operation} returned malformed JSON`)
  }
}

function combineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function authHeaders(cookie) {
  if (!cookie || cookie.length > 8_192 || /[\u0000-\u001f\u007f]/.test(cookie)) {
    throw new Error('MYCHAT_OPS_COOKIE is required and must be a bounded HTTP cookie value')
  }
  return { Accept: 'application/json', Cookie: cookie }
}

async function fetchExpected(url, init, expectedStatuses, operation, timeoutMs, signal) {
  const response = await fetch(url, { ...init, redirect: 'error', signal: combineSignal(signal, timeoutMs) })
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${operation} returned HTTP ${response.status}`)
  }
  return boundedResponseJson(response, operation)
}

export async function createRealWorkflowDriver(options, environment = process.env) {
  assertRealAuthorization(options, environment)
  const baseUrl = normalizeBaseUrl(environment.MYCHAT_OPS_BASE_URL?.trim() ?? '', environment)
  const expectedRevision = environment.MYCHAT_OPS_EXPECTED_REVISION?.trim().toLowerCase() ?? ''
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)
  if (!loopback && !/^[0-9a-f]{7,64}$/.test(expectedRevision)) {
    throw new Error('MYCHAT_OPS_EXPECTED_REVISION is required for remote staging')
  }
  const cookie = environment.MYCHAT_OPS_COOKIE?.trim() ?? ''
  const fixtures = options.fixturesPath
    ? await loadStagingFixtures(options.fixturesPath, baseUrl.host)
    : { titleRequests: [], jobIds: [], digest: null }
  const timeoutMs = options.timeoutMs

  const driver = {
    mode: 'real',
    target: { origin: baseUrl.origin, expectedRevision, fixtureDigest: fixtures.digest },
    fixtures,
    async ready({ signal } = {}) {
      const payload = await fetchExpected(
        new URL('/api/ready', baseUrl),
        { headers: { Accept: 'application/json' } },
        [200],
        'readiness check',
        timeoutMs,
        signal,
      )
      const result = validateReadyPayload(payload, expectedRevision, false)
      return { status: 'ready', revision: result.revision }
    },
    async start(request, { signal } = {}) {
      const payload = await fetchExpected(
        new URL('/api/chat/title', baseUrl),
        {
          method: 'POST',
          headers: { ...authHeaders(cookie), 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
        },
        [202],
        'title start',
        timeoutMs,
        signal,
      )
      const result = objectOf(payload)
      if (!result || result.schemaVersion !== 1 || typeof result.jobId !== 'string'
        || !UUID.test(result.jobId) || !JOB_STATUS.has(result.status)
        || typeof result.created !== 'boolean') {
        throw new Error('Title start returned an invalid contract')
      }
      return { executionId: result.jobId, status: result.status, created: result.created }
    },
    async status(executionId, { signal } = {}) {
      if (!UUID.test(executionId)) throw new Error('Invalid executionId')
      const payload = await fetchExpected(
        new URL(`/api/v1/jobs/${executionId}`, baseUrl),
        { headers: authHeaders(cookie) },
        [200],
        'workflow status',
        timeoutMs,
        signal,
      )
      const job = objectOf(objectOf(payload)?.job)
      if (!job || job.id !== executionId || !JOB_STATUS.has(job.status)) {
        throw new Error('Workflow status returned an invalid contract')
      }
      return { executionId, status: job.status, terminal: TERMINAL.has(job.status) }
    },
    async cancel(executionId, { signal } = {}) {
      if (!UUID.test(executionId)) throw new Error('Invalid executionId')
      const payload = await fetchExpected(
        new URL(`/api/v1/jobs/${executionId}/cancel`, baseUrl),
        {
          method: 'POST',
          headers: { ...authHeaders(cookie), 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'staging chaos verification' }),
        },
        [200, 202],
        'workflow cancellation',
        timeoutMs,
        signal,
      )
      const result = objectOf(payload)
      if (!result || result.jobId !== executionId || !JOB_STATUS.has(result.status)
        || typeof result.accepted !== 'boolean' || typeof result.replayed !== 'boolean') {
        throw new Error('Workflow cancellation returned an invalid contract')
      }
      return {
        executionId,
        status: result.status,
        accepted: result.accepted,
        replayed: result.replayed,
      }
    },
  }
  await driver.ready()
  return driver
}

function deterministicUuid(value) {
  const hash = createHash('sha256').update(value).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function mockTitleRequest(index, namespace = 'load') {
  return {
    fixtureKey: `${namespace}:${index}`,
    conversationId: deterministicUuid(`${namespace}:conversation:${index}`),
    userText: `mock user text ${index}`,
    assistantText: `mock assistant text ${index}`,
  }
}

export function createMockWorkflowDriver({ seed = 1, minimumLatencyMs = 1, maximumLatencyMs = 4 } = {}) {
  const random = createSeededRandom(seed)
  const executions = new Map()
  const keys = new Map()
  const failures = new Map()

  function failIfRequested(operation) {
    const remaining = failures.get(operation) ?? 0
    if (remaining <= 0) return
    failures.set(operation, remaining - 1)
    throw new Error(`Injected ${operation} dependency outage`)
  }

  async function latency(signal) {
    const duration = minimumLatencyMs + Math.floor(random() * (maximumLatencyMs - minimumLatencyMs + 1))
    await sleep(duration, signal)
  }

  return {
    mode: 'mock',
    target: { origin: 'mock://workflow', expectedRevision: 'mock0001', fixtureDigest: null },
    fixtures: { titleRequests: [], jobIds: [], digest: null },
    injectFailures(operation, count) {
      failures.set(operation, count)
    },
    async ready({ signal } = {}) {
      failIfRequested('ready')
      await latency(signal)
      return { status: 'ready', revision: 'mock0001' }
    },
    async start(request, { signal } = {}) {
      failIfRequested('start')
      const key = request.fixtureKey ?? request.conversationId
      let executionId = keys.get(key)
      const created = executionId === undefined
      if (!executionId) {
        executionId = deterministicUuid(`execution:${key}`)
        keys.set(key, executionId)
        executions.set(executionId, { status: 'queued', polls: 0 })
      }
      // The commit happens before the response, modeling an ambiguous client abort.
      await latency(signal)
      return { executionId, status: executions.get(executionId).status, created }
    },
    async status(executionId, { signal } = {}) {
      failIfRequested('status')
      const execution = executions.get(executionId)
      if (!execution) throw new Error('Mock execution was not found')
      await latency(signal)
      execution.polls += 1
      if (execution.status === 'queued') execution.status = 'running'
      else if (execution.status === 'running') execution.status = 'completed'
      return { executionId, status: execution.status, terminal: TERMINAL.has(execution.status) }
    },
    async cancel(executionId, { signal } = {}) {
      failIfRequested('cancel')
      const execution = executions.get(executionId)
      if (!execution) throw new Error('Mock execution was not found')
      const replayed = execution.status === 'cancelled'
      if (!TERMINAL.has(execution.status)) execution.status = 'cancelled'
      await latency(signal)
      return { executionId, status: execution.status, accepted: true, replayed }
    },
  }
}

export function titleFixture(driver, index, namespace, { allowReplay = false } = {}) {
  if (driver.mode === 'mock') return mockTitleRequest(index, namespace)
  const fixtures = driver.fixtures.titleRequests
  if (fixtures.length === 0) throw new Error('No titleRequests are available in the staging fixture file')
  if (!allowReplay && index >= fixtures.length) throw new Error('Unique title fixtures were exhausted')
  return fixtures[index % fixtures.length]
}

export function jobFixture(driver, index) {
  if (driver.mode === 'mock') throw new Error('Mock job fixtures must be created by the scenario')
  const fixtures = driver.fixtures.jobIds
  if (fixtures.length === 0) throw new Error('No jobIds are available in the staging fixture file')
  return fixtures[index % fixtures.length]
}

export function isTerminalStatus(status) {
  return TERMINAL.has(status)
}
