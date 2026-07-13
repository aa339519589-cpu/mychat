export const JOB_EVENT_SCHEMA_VERSION = 1 as const

export const JOB_STATUSES = [
  'queued',
  'leased',
  'running',
  'awaiting_input',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
] as const

export type JobStatus = typeof JOB_STATUSES[number]
export type JobTerminalStatus = Extract<JobStatus, 'completed' | 'failed' | 'cancelled'>
export type JobActiveStatus = Exclude<JobStatus, JobTerminalStatus>
export type JobAuthClass = 'anonymous' | 'registered' | 'service'
export type JobErrorClass = 'retryable' | 'user' | 'provider' | 'policy' | 'internal'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type JobPrincipal = {
  id: string
  authClass: JobAuthClass
}

export type JobBudget = {
  wallTimeMs?: number
  tokenLimit?: number
  costMicros?: number
  sandboxTimeMs?: number
  toolCallLimit?: number
  [key: string]: JsonValue | undefined
}

export type JobFailure = {
  code: string
  message: string
  retryable: boolean
  class: JobErrorClass
  details: JsonObject
}

export type JobLease = {
  owner: string
  version: number
  expiresAt: string
}

export type JobRecord = {
  id: string
  type: string
  queue: string
  principal: JobPrincipal
  subject: JsonObject
  inputHash: string
  input: JsonValue
  status: JobStatus
  attempt: number
  maxAttempts: number
  priority: number
  availableAt: string
  budget: JobBudget
  checkpoint: JsonValue | null
  result: JsonValue | null
  error: JobFailure | null
  lease: JobLease | null
  cancelRequestedAt: string | null
  createdAt: string
  updatedAt: string
  terminalAt: string | null
}

export type JobEvent = {
  jobId: string
  seq: number
  schemaVersion: typeof JOB_EVENT_SCHEMA_VERSION
  kind: string
  payload: JsonObject
  createdAt: string
}

export type JobEventDraft = {
  schemaVersion?: typeof JOB_EVENT_SCHEMA_VERSION
  kind: string
  payload: JsonObject
  idempotencyKey?: string
}

export type EnqueueJobInput = {
  jobId: string
  type: string
  queue: string
  principal: JobPrincipal
  subject: JsonObject
  idempotencyKey: string
  inputHash: string
  input: JsonObject
  budget?: JobBudget
  priority?: number
  maxAttempts?: number
  availableAt?: string
}

export type JobFence = {
  jobId: string
  workerId: string
  leaseVersion: number
}

export const JOB_LIMITS = {
  identifierLength: 256,
  typeLength: 96,
  queueLength: 64,
  eventTypeLength: 96,
  eventBatchSize: 64,
  priorityMinimum: -1_000,
  priorityMaximum: 1_000,
  maxAttempts: 100,
  leaseSecondsMinimum: 15,
  leaseSecondsMaximum: 900,
  workerConcurrencyMaximum: 16,
} as const

const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
])

const JOB_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value)
}

export function isTerminalJobStatus(value: unknown): value is JobTerminalStatus {
  return isJobStatus(value) && TERMINAL_JOB_STATUSES.has(value)
}

export function isJobName(value: unknown, maximumLength: number = JOB_LIMITS.typeLength): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximumLength
    && JOB_NAME_PATTERN.test(value)
}

export function isJobIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= JOB_LIMITS.identifierLength
    && !/[\u0000-\u001f\u007f]/.test(value)
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function assertJobFence(fence: JobFence): void {
  if (!isJobIdentifier(fence.jobId) || !isJobIdentifier(fence.workerId)
    || !Number.isSafeInteger(fence.leaseVersion) || fence.leaseVersion < 1) {
    throw new TypeError('Invalid job fencing token')
  }
}

export function assertEnqueueJobInput(input: EnqueueJobInput): void {
  if (!isJobIdentifier(input.jobId)
    || !isJobName(input.type)
    || !isJobName(input.queue, JOB_LIMITS.queueLength)
    || !isJobIdentifier(input.principal.id)
    || !isJobIdentifier(input.idempotencyKey)
    || !isJobIdentifier(input.inputHash)
    || input.inputHash.length < 16
    || !input.type.includes('.')) {
    throw new TypeError('Invalid job identity')
  }
  if (!['anonymous', 'registered', 'service'].includes(input.principal.authClass)) {
    throw new TypeError('Invalid job principal')
  }
  const priority = input.priority ?? 0
  const maxAttempts = input.maxAttempts ?? 3
  if (!Number.isSafeInteger(priority)
    || priority < JOB_LIMITS.priorityMinimum
    || priority > JOB_LIMITS.priorityMaximum
    || !Number.isSafeInteger(maxAttempts)
    || maxAttempts < 1
    || maxAttempts > JOB_LIMITS.maxAttempts) {
    throw new TypeError('Invalid job scheduling limits')
  }
  if (input.availableAt !== undefined && !isIsoTimestamp(input.availableAt)) {
    throw new TypeError('Invalid job availability timestamp')
  }
}

export function assertJobEvents(events: readonly JobEventDraft[]): void {
  if (events.length < 1 || events.length > JOB_LIMITS.eventBatchSize) {
    throw new TypeError('Invalid job event batch size')
  }
  for (const event of events) {
    if (!isJobName(event.kind, JOB_LIMITS.eventTypeLength) || !event.kind.includes('.')
      || (event.schemaVersion ?? JOB_EVENT_SCHEMA_VERSION) !== JOB_EVENT_SCHEMA_VERSION
      || (event.idempotencyKey !== undefined && !isJobIdentifier(event.idempotencyKey))) {
      throw new TypeError('Invalid job event')
    }
  }
}

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth >= 32 || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    return value.length <= 10_000 && value.every(entry => isJsonValue(entry, depth + 1))
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const entries = Object.entries(value)
  return entries.length <= 10_000
    && entries.every(([, entry]) => isJsonValue(entry, depth + 1))
}
