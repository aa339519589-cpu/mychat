import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveRuntimeConfiguration,
  runtimeRole,
  type RuntimeEnvironment,
  type RuntimeRole,
} from '../lib/runtime-config'
import { createAdminClient } from '../lib/supabase/admin'
import { createMaestroTask, MAESTRO_BRANCH, publicMaestroTask } from '../lib/maestro/store'

const FORCE_STOP_AFTER_MS = 250_000
const RH75_OBJECTIVE = "Research the Riemann zeta function and obtain a rigorous unconditional lower bound of at least 75% for the proportion of nontrivial zeros that are both simple and on the critical line, with denominator counting all nontrivial zeros with multiplicity. The target is liminf_{T->infinity} N^s_0(T,2T)/N(T,2T) >= 0.75. Do not redefine or weaken the target. Any result below 75% is only a checkpoint and must not be treated as completion. Do not fabricate a proof or numerical bound. Continue across Maestro worker turns until the stated target has a rigorous unconditional proof, and require the independent review turn to verify every essential analytic inequality and logical step before finish."

type Service = {
  name: 'web' | 'worker'
  command: string
  args: string[]
}

type StartProductionOptions = {
  env?: RuntimeEnvironment
  forwardedArgs?: string[]
  execPath?: string
  spawnChild?: typeof spawn
}

export const resolveRuntimeRole = runtimeRole

export function servicesForRuntimeRole(
  role: RuntimeRole | string | undefined,
  forwardedArgs = process.argv.slice(2),
  execPath = process.execPath,
): Service[] {
  const selectedRole = runtimeRole(role)
  const services: Service[] = [
    {
      name: 'web',
      command: execPath,
      args: ['node_modules/next/dist/bin/next', 'start', ...forwardedArgs],
    },
    {
      name: 'worker',
      command: execPath,
      args: ['--import', 'tsx', 'job-worker.ts'],
    },
  ]
  return selectedRole === 'all'
    ? services
    : services.filter(service => service.name === selectedRole)
}

async function resolveMaestroOwnerUserId(): Promise<string> {
  const configured = process.env.MAESTRO_OWNER_USER_ID?.trim()
  if (configured) return configured
  const admin = createAdminClient()
  if (!admin) throw new Error('Maestro storage is unavailable')

  const latestMaestro = await admin.from('agent_tasks')
    .select('user_id')
    .eq('branch', MAESTRO_BRANCH)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestMaestro.error) throw new Error(latestMaestro.error.message)
  if (latestMaestro.data?.user_id) return latestMaestro.data.user_id

  const latestTask = await admin.from('agent_tasks')
    .select('user_id')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestTask.error) throw new Error(latestTask.error.message)
  if (latestTask.data?.user_id) return latestTask.data.user_id

  const users = await admin.auth.admin.listUsers({ page: 1, perPage: 2 })
  if (users.error) throw new Error(users.error.message)
  if (users.data.users.length === 1) return users.data.users[0].id
  throw new Error('Unable to resolve Maestro owner')
}

async function bootstrapRh75Maestro(environment: RuntimeEnvironment): Promise<void> {
  if (environment.MAESTRO_BOOTSTRAP_RH75 !== '1') return
  const admin = createAdminClient()
  if (!admin) throw new Error('Maestro storage is unavailable')

  const existing = await admin.from('agent_tasks')
    .select('id,user_id,goal,mode,repo,branch,status,error,created_at,updated_at,started_at,finished_at,meta,agent_branch,pull_request_url,pull_request_number,commit_sha')
    .eq('branch', MAESTRO_BRANCH)
    .eq('goal', RH75_OBJECTIVE)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (existing.error) throw new Error(existing.error.message)

  let task = existing.data ? publicMaestroTask(existing.data) : null
  if (!task) {
    const userId = await resolveMaestroOwnerUserId()
    const row = await createMaestroTask(admin, userId, RH75_OBJECTIVE, 100_000)
    task = publicMaestroTask(row)
  }
  if (!task) throw new Error('Maestro task metadata is invalid')
  console.log(`[maestro-bootstrap] RH75_START_CODE=${task.startCode}`)
  console.log(`[maestro-bootstrap] RH75_JOB_ID=${task.id}`)
}

export async function startProduction(options: StartProductionOptions = {}): Promise<number> {
  const environment = options.env ?? process.env
  await bootstrapRh75Maestro(environment)
  const configuration = resolveRuntimeConfiguration(environment)
  const services = servicesForRuntimeRole(
    configuration.role,
    options.forwardedArgs ?? process.argv.slice(2),
    options.execPath ?? process.execPath,
  )
  const spawnChild = options.spawnChild ?? spawn
  const children = services.map(service => ({
    ...service,
    child: spawnChild(service.command, service.args, {
      env: environment as NodeJS.ProcessEnv,
      stdio: 'inherit',
    }) as ChildProcess,
  }))

  let stopping = false
  let exitCode = 0
  let forceTimer: ReturnType<typeof setTimeout> | undefined

  function stop(signal: NodeJS.Signals = 'SIGTERM', code = 0): void {
    if (stopping) return
    stopping = true
    exitCode = code

    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    }

    forceTimer = setTimeout(() => {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }, FORCE_STOP_AFTER_MS)
    forceTimer.unref()
  }

  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const handler = () => stop(signal, 0)
    signalHandlers.set(signal, handler)
    process.once(signal, handler)
  }

  for (const { name, child } of children) {
    child.once('error', error => {
      console.error(`[production] ${name} failed to start`, error)
      stop('SIGTERM', 1)
    })
    child.once('exit', (code, signal) => {
      if (!stopping) {
        console.error(`[production] ${name} exited unexpectedly`, { code, signal })
        stop('SIGTERM', code || 1)
      }
    })
  }

  try {
    await Promise.all(children.map(({ child }) => new Promise<void>(resolveClose => {
      child.once('close', () => resolveClose())
    })))
  } finally {
    if (forceTimer) clearTimeout(forceTimer)
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  }

  return exitCode
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  startProduction().then(code => {
    process.exitCode = code
  }).catch(error => {
    console.error('[production] invalid supervisor configuration', error)
    process.exitCode = 1
  })
}
