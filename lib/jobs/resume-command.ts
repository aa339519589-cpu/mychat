import type { JsonObject } from './contracts'

export const JOB_RESUME_BODY_MAX_BYTES = 70 * 1024
export const JOB_RESUME_INPUT_MAX_BYTES = 64 * 1024

export type ResumeAwaitingJobCommand = {
  expectedCheckpointVersion: number
  idempotencyKey: string
  resumeInput: JsonObject
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Validate the complete v1 resume command before any control-plane mutation. */
export function parseResumeAwaitingJobCommand(
  value: unknown,
  idempotencyHeader: string | null,
): ResumeAwaitingJobCommand {
  const body = record(value)
  const resumeInput = record(body?.resumeInput)
  const expectedCheckpointVersion = body?.expectedCheckpointVersion
  const idempotencyKey = idempotencyHeader?.trim() ?? ''
  if (!body || Object.keys(body).some(key => ![
    'expectedCheckpointVersion', 'resumeInput',
  ].includes(key))
    || !Number.isSafeInteger(expectedCheckpointVersion)
    || Number(expectedCheckpointVersion) < 1
    || !resumeInput
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey)) {
    throw new TypeError('Invalid awaiting job resume command')
  }
  let inputBytes = Number.POSITIVE_INFINITY
  try {
    inputBytes = new TextEncoder().encode(JSON.stringify(resumeInput)).byteLength
  } catch {
    // Leave the sentinel above so non-JSON/cyclic values fail closed.
  }
  if (inputBytes > JOB_RESUME_INPUT_MAX_BYTES) {
    throw new TypeError('Invalid awaiting job resume command')
  }
  return {
    expectedCheckpointVersion: Number(expectedCheckpointVersion),
    idempotencyKey,
    resumeInput: resumeInput as JsonObject,
  }
}
