import {
  JOB_LIMITS,
  isIsoTimestamp,
  isJobIdentifier,
  isJobName,
  isJsonValue,
  type JobAuthClass,
  type JobBudget,
  type JobCheckpoint,
  type JobLease,
  type JobPrincipal,
  type JobRecord,
  type JobStatus,
  type JobUsage,
  type JsonObject,
  type JsonValue,
} from './contracts'
import {
  failureOf,
  integerOf,
  malformed,
  objectOf,
  statusOf,
} from './supabase-parsing'

function recordOf(value: unknown, rpcName: string): Record<string, unknown> {
  return objectOf(value) ?? malformed(rpcName)
}

function nestedRecordOf(value: unknown, rpcName: string): Record<string, unknown> | null {
  if (value == null) return null
  return recordOf(value, rpcName)
}

function integerBetween(value: unknown, minimum: number, maximum: number, rpcName: string): number {
  const parsed = integerOf(value)
  if (parsed === null || parsed < minimum || parsed > maximum) return malformed(rpcName)
  return parsed
}

function timestampOf(value: unknown, rpcName: string): string {
  return isIsoTimestamp(value) ? value : malformed(rpcName)
}

function optionalTimestampOf(value: unknown, rpcName: string): string | null {
  return value == null ? null : timestampOf(value, rpcName)
}

function jsonValueOf(value: unknown, rpcName: string): JsonValue {
  return isJsonValue(value) ? value : malformed(rpcName)
}

function jsonObjectOf(value: unknown, rpcName: string): JsonObject {
  const parsed = jsonValueOf(value, rpcName)
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') return malformed(rpcName)
  return parsed
}

function identifierOf(value: unknown, rpcName: string): string {
  return isJobIdentifier(value) ? value : malformed(rpcName)
}

function authClassOf(value: unknown, rpcName: string): JobAuthClass {
  if (value === 'anonymous' || value === 'registered' || value === 'service') return value
  return malformed(rpcName)
}

function jobNameOf(value: unknown, maximum: number, rpcName: string, requireDot = false): string {
  if (!isJobName(value, maximum) || (requireDot && !value.includes('.'))) return malformed(rpcName)
  return value
}

function principalOf(source: Record<string, unknown>, rpcName: string): JobPrincipal {
  const nested = nestedRecordOf(source.principal, rpcName)
  return {
    id: identifierOf(nested?.id ?? source.principalId, rpcName),
    authClass: authClassOf(nested?.authClass ?? source.authClass, rpcName),
  }
}

function usageOf(value: unknown, rpcName: string): JobUsage {
  if (value == null) return {
    wallTimeMs: 0,
    rawTokens: 0,
    weightedTokens: 0,
    costMicros: 0,
    sandboxTimeMs: 0,
    toolCalls: 0,
  }
  const source = recordOf(value, rpcName)
  return {
    wallTimeMs: integerBetween(source.wallTimeMs, 0, Number.MAX_SAFE_INTEGER, rpcName),
    rawTokens: integerBetween(source.rawTokens, 0, Number.MAX_SAFE_INTEGER, rpcName),
    weightedTokens: integerBetween(source.weightedTokens, 0, Number.MAX_SAFE_INTEGER, rpcName),
    costMicros: integerBetween(source.costMicros, 0, Number.MAX_SAFE_INTEGER, rpcName),
    sandboxTimeMs: integerBetween(source.sandboxTimeMs, 0, Number.MAX_SAFE_INTEGER, rpcName),
    toolCalls: integerBetween(source.toolCalls, 0, Number.MAX_SAFE_INTEGER, rpcName),
  }
}

function checkpointOf(value: unknown, rpcName: string): JobCheckpoint | null {
  if (value == null) return null
  const source = recordOf(value, rpcName)
  if (typeof source.resumable !== 'boolean') return malformed(rpcName)
  return {
    version: integerBetween(source.version, 1, Number.MAX_SAFE_INTEGER, rpcName),
    phase: jobNameOf(source.phase, 128, rpcName),
    data: jsonObjectOf(source.data, rpcName),
    progress: jsonObjectOf(source.progress, rpcName),
    resumable: source.resumable,
    leaseVersion: integerBetween(source.leaseVersion, 1, Number.MAX_SAFE_INTEGER, rpcName),
    updatedAt: timestampOf(source.updatedAt, rpcName),
  }
}

function leaseOf(source: Record<string, unknown>, rpcName: string): JobLease | null {
  const nested = nestedRecordOf(source.lease, rpcName)
  const owner = nested?.owner ?? source.leaseOwner
  const version = nested?.version ?? source.leaseVersion
  const expiresAt = nested?.expiresAt ?? source.leaseExpiresAt
  if (owner == null && expiresAt == null) {
    integerBetween(version, 0, Number.MAX_SAFE_INTEGER, rpcName)
    return null
  }
  return {
    owner: identifierOf(owner, rpcName),
    version: integerBetween(version, 1, Number.MAX_SAFE_INTEGER, rpcName),
    expiresAt: timestampOf(expiresAt, rpcName),
  }
}

function scheduleOf(source: Record<string, unknown>, rpcName: string): {
  status: JobStatus
  attempt: number
  maxAttempts: number
  priority: number
  availableAt: string
} {
  const maxAttempts = integerBetween(source.maxAttempts, 1, JOB_LIMITS.maxAttempts, rpcName)
  const attempt = integerBetween(source.attempt, 0, JOB_LIMITS.maxAttempts, rpcName)
  if (attempt > maxAttempts) return malformed(rpcName)
  return {
    status: statusOf(source.status) ?? malformed(rpcName),
    attempt,
    maxAttempts,
    priority: integerBetween(
      source.priority, JOB_LIMITS.priorityMinimum, JOB_LIMITS.priorityMaximum, rpcName,
    ),
    availableAt: timestampOf(source.availableAt, rpcName),
  }
}

function inputHashOf(value: unknown, rpcName: string): string {
  if (!isJobIdentifier(value) || value.length < 16) return malformed(rpcName)
  return value
}

function optionalJsonValueOf(value: unknown, rpcName: string): JsonValue | null {
  return value == null ? null : jsonValueOf(value, rpcName)
}

export function parseJobRecord(value: unknown, rpcName: string): JobRecord {
  const source = recordOf(value, rpcName)
  const schedule = scheduleOf(source, rpcName)
  return {
    id: identifierOf(source.id, rpcName),
    type: jobNameOf(source.type, JOB_LIMITS.typeLength, rpcName, true),
    queue: jobNameOf(source.queue, JOB_LIMITS.queueLength, rpcName),
    principal: principalOf(source, rpcName),
    subject: jsonObjectOf(source.subject, rpcName),
    inputHash: inputHashOf(source.inputHash, rpcName),
    input: jsonValueOf(source.input ?? source.payload, rpcName),
    ...schedule,
    budget: jsonObjectOf(source.budget, rpcName) as JobBudget,
    usage: usageOf(source.usage, rpcName),
    checkpoint: checkpointOf(source.checkpoint, rpcName),
    result: optionalJsonValueOf(source.result, rpcName),
    error: failureOf(source),
    lease: leaseOf(source, rpcName),
    cancelRequestedAt: optionalTimestampOf(source.cancelRequestedAt, rpcName),
    createdAt: timestampOf(source.createdAt, rpcName),
    updatedAt: timestampOf(source.updatedAt, rpcName),
    terminalAt: optionalTimestampOf(source.terminalAt, rpcName),
  }
}
