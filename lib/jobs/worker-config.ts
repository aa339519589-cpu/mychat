import { JobRuntimeError } from './errors'

export const defaultJobSleep = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise(
  (resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  },
)

export function boundedJobInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', `Invalid ${label}`)
  }
  return value
}

export function nextJobBackoff(
  currentMs: number,
  maximumMs: number,
  jitter: number,
  random: () => number,
): { waitMs: number; nextMs: number } {
  return {
    waitMs: Math.min(maximumMs, jitteredJobInterval(currentMs, jitter, random)),
    nextMs: Math.min(maximumMs, currentMs * 2),
  }
}

export function jitteredJobInterval(
  baseMs: number,
  jitter: number,
  random: () => number,
): number {
  const sample = random()
  const boundedRandom = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5
  const factor = 1 - jitter + (2 * jitter * boundedRandom)
  return Math.max(1, Math.round(baseMs * factor))
}

export function jobLeaseRenewalSchedule(
  leaseSeconds: number,
  intervalMs: number | undefined,
  jitter: number | undefined,
): { intervalMs: number; jitter: number } {
  const boundedInterval = boundedJobInteger(
    intervalMs ?? Math.floor(leaseSeconds * 1_000 / 3),
    100,
    leaseSeconds * 500,
    'job lease renewal interval',
  )
  const boundedJitter = jitter ?? 0.1
  if (!Number.isFinite(boundedJitter) || boundedJitter < 0 || boundedJitter > 0.25
    || Math.ceil(boundedInterval * (1 + boundedJitter)) > leaseSeconds * 500) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job lease renewal jitter')
  }
  return { intervalMs: boundedInterval, jitter: boundedJitter }
}

export function nextJobLeaseRenewalDelay(
  remainingLeaseMs: number,
  intervalMs: number,
  jitter: number,
  random: () => number,
): number {
  return Math.min(remainingLeaseMs, jitteredJobInterval(intervalMs, jitter, random))
}
