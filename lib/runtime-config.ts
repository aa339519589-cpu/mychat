import { assertProductionAgentSandbox } from './agent/execution-policy'
import { jobMaintenanceMode, type JobMaintenanceMode } from './jobs/maintenance'
import { streamAdmissionHashKey } from './jobs/stream-admission'
import { metricsBearerToken } from './observability/metrics-auth'
import { workflowRuntimeMode, type WorkflowRuntimeMode } from './workflows/config'

export const RUNTIME_ROLES = ['all', 'web', 'worker'] as const
export type RuntimeRole = typeof RUNTIME_ROLES[number]
export type RuntimeServiceRole = Exclude<RuntimeRole, 'all'>

export type RuntimeEnvironment = Record<string, string | undefined> & {
  NODE_ENV?: string
  MYCHAT_RUNTIME_ROLE?: string
  MYCHAT_MAINTENANCE_MODE?: string
  GENERATION_MAINTENANCE_MODE?: string
  MYCHAT_WORKFLOW_RUNTIME?: string
  MYCHAT_BUILD_REVISION?: string
  RENDER_GIT_COMMIT?: string
  VERCEL_GIT_COMMIT_SHA?: string
  NEXT_PUBLIC_SUPABASE_URL?: string
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STREAM_ADMISSION_HASH_KEY?: string
  METRICS_BEARER_TOKEN?: string
  E2B_API_KEY?: string
  DEEPSEEK_API_KEY?: string
  AGENT_CREDENTIAL_KEY?: string
  AGENT_CREDENTIAL_KEY_PREVIOUS?: string
  AGENT_PUBLIC_URL?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  JOB_WORKER_ID?: string
  JOB_CHAT_CONCURRENCY?: string
  JOB_MEDIA_CONCURRENCY?: string
  JOB_TITLE_CONCURRENCY?: string
  JOB_AGENT_CONCURRENCY?: string
}

export type WorkerConcurrency = Readonly<{
  chat: number
  media: number
  title: number
  agent: number
}>

export type RuntimeConfiguration = Readonly<{
  production: boolean
  role: RuntimeRole
  services: readonly RuntimeServiceRole[]
  revision: string
  maintenanceMode: JobMaintenanceMode
  workflowRuntime: WorkflowRuntimeMode
  workerId?: string
  workerConcurrency: WorkerConcurrency
}>

const MINIMUM_SECRET_BYTES = 32
const PRODUCTION_SERVICES: readonly RuntimeServiceRole[] = ['web', 'worker']

function trimmed(environment: RuntimeEnvironment, name: keyof RuntimeEnvironment): string {
  const value = environment[name]
  return typeof value === 'string' ? value.trim() : ''
}

function requireValue(
  environment: RuntimeEnvironment,
  name: keyof RuntimeEnvironment,
  service: RuntimeServiceRole,
): string {
  const value = trimmed(environment, name)
  if (!value) throw new Error(`${String(name)} is required for the production ${service} role`)
  return value
}

function requireSecret(
  environment: RuntimeEnvironment,
  name: keyof RuntimeEnvironment,
  service: RuntimeServiceRole,
  minimumBytes = MINIMUM_SECRET_BYTES,
): string {
  const value = requireValue(environment, name, service)
  if (Buffer.byteLength(value, 'utf8') < minimumBytes) {
    throw new Error(`${String(name)} must contain at least ${minimumBytes} bytes`)
  }
  return value
}

function productionHttpsUrl(value: string, name: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials or a fragment`)
  }
  return url.href
}

function concurrency(environment: RuntimeEnvironment, name: keyof RuntimeEnvironment, fallback: number): number {
  const raw = trimmed(environment, name)
  const configured = raw ? Number(raw) : fallback
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 16) {
    throw new Error(`${String(name)} must be an integer between 1 and 16`)
  }
  return configured
}

function configuredRevision(environment: RuntimeEnvironment): string {
  const raw = trimmed(environment, 'MYCHAT_BUILD_REVISION')
    || trimmed(environment, 'RENDER_GIT_COMMIT')
    || trimmed(environment, 'VERCEL_GIT_COMMIT_SHA')
  return raw && /^[a-f0-9]{7,64}$/i.test(raw) ? raw.slice(0, 12).toLowerCase() : 'unknown'
}

function validateCredentialRotation(environment: RuntimeEnvironment, production: boolean): void {
  const current = trimmed(environment, 'AGENT_CREDENTIAL_KEY')
  const previous = trimmed(environment, 'AGENT_CREDENTIAL_KEY_PREVIOUS')
  if (current && Buffer.byteLength(current, 'utf8') < MINIMUM_SECRET_BYTES) {
    throw new Error(`AGENT_CREDENTIAL_KEY must contain at least ${MINIMUM_SECRET_BYTES} bytes`)
  }
  if (previous && Buffer.byteLength(previous, 'utf8') < MINIMUM_SECRET_BYTES) {
    throw new Error(`AGENT_CREDENTIAL_KEY_PREVIOUS must contain at least ${MINIMUM_SECRET_BYTES} bytes`)
  }
  if (previous && !current) throw new Error('AGENT_CREDENTIAL_KEY_PREVIOUS requires AGENT_CREDENTIAL_KEY')
  if (production && previous && previous === current) {
    throw new Error('AGENT_CREDENTIAL_KEY_PREVIOUS must differ from AGENT_CREDENTIAL_KEY')
  }
}

function validateGithubPair(environment: RuntimeEnvironment): void {
  const clientId = trimmed(environment, 'GITHUB_CLIENT_ID')
  const clientSecret = trimmed(environment, 'GITHUB_CLIENT_SECRET')
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured together')
  }
}

function validateProductionWeb(environment: RuntimeEnvironment): void {
  const publicUrl = requireValue(environment, 'NEXT_PUBLIC_SUPABASE_URL', 'web')
  productionHttpsUrl(publicUrl, 'NEXT_PUBLIC_SUPABASE_URL')
  productionHttpsUrl(trimmed(environment, 'SUPABASE_URL') || publicUrl, 'SUPABASE_URL')
  requireValue(environment, 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'web')
  requireSecret(environment, 'SUPABASE_SERVICE_ROLE_KEY', 'web')
  requireSecret(environment, 'STREAM_ADMISSION_HASH_KEY', 'web')
  if (!streamAdmissionHashKey(environment)) {
    throw new Error('STREAM_ADMISSION_HASH_KEY must contain at least 32 bytes')
  }
  if (!metricsBearerToken(environment)) {
    throw new Error('METRICS_BEARER_TOKEN must be an encoded secret containing at least 32 bytes')
  }
  productionHttpsUrl(requireValue(environment, 'AGENT_PUBLIC_URL', 'web'), 'AGENT_PUBLIC_URL')
  // GitHub OAuth is optional as a complete integration; its routes fail closed.
  requireSecret(environment, 'AGENT_CREDENTIAL_KEY', 'web')
}

function validateProductionWorker(environment: RuntimeEnvironment): void {
  productionHttpsUrl(
    trimmed(environment, 'SUPABASE_URL')
      || requireValue(environment, 'NEXT_PUBLIC_SUPABASE_URL', 'worker'),
    'SUPABASE_URL',
  )
  requireSecret(environment, 'SUPABASE_SERVICE_ROLE_KEY', 'worker')
  requireValue(environment, 'DEEPSEEK_API_KEY', 'worker')
  requireSecret(environment, 'AGENT_CREDENTIAL_KEY', 'worker')
  assertProductionAgentSandbox(environment)
}

export function runtimeRole(value: string | undefined): RuntimeRole {
  const role = value?.trim() || 'all'
  if ((RUNTIME_ROLES as readonly string[]).includes(role)) return role as RuntimeRole
  throw new Error(`Invalid MYCHAT_RUNTIME_ROLE "${role}"; expected all, web, or worker`)
}

export function runtimeServices(role: RuntimeRole): readonly RuntimeServiceRole[] {
  return role === 'all' ? PRODUCTION_SERVICES : [role]
}

export function resolveRuntimeConfiguration(
  environment: RuntimeEnvironment = process.env,
  roleOverride?: RuntimeRole,
): RuntimeConfiguration {
  const role = roleOverride ?? runtimeRole(environment.MYCHAT_RUNTIME_ROLE)
  const services = runtimeServices(role)
  const production = trimmed(environment, 'NODE_ENV').toLowerCase() === 'production'
  const revision = configuredRevision(environment)
  const workerConcurrency = Object.freeze({
    chat: concurrency(environment, 'JOB_CHAT_CONCURRENCY', 2),
    media: concurrency(environment, 'JOB_MEDIA_CONCURRENCY', 1),
    title: concurrency(environment, 'JOB_TITLE_CONCURRENCY', 1),
    agent: concurrency(environment, 'JOB_AGENT_CONCURRENCY', 1),
  })

  validateCredentialRotation(environment, production)
  validateGithubPair(environment)
  const maintenanceMode = jobMaintenanceMode(environment)
  const workflowRuntime = workflowRuntimeMode(environment.MYCHAT_WORKFLOW_RUNTIME)

  if (production) {
    if (revision === 'unknown') throw new Error('Production runtime requires an immutable build revision')
    if (services.includes('web')) validateProductionWeb(environment)
    if (services.includes('worker')) validateProductionWorker(environment)
  }

  const workerId = trimmed(environment, 'JOB_WORKER_ID') || undefined
  if (workerId && (workerId.length > 256 || /[\u0000-\u001f\u007f]/.test(workerId))) {
    throw new Error('JOB_WORKER_ID must be a printable identifier no longer than 256 characters')
  }

  return Object.freeze({
    production,
    role,
    services,
    revision,
    maintenanceMode,
    workflowRuntime,
    ...(workerId ? { workerId } : {}),
    workerConcurrency,
  })
}
