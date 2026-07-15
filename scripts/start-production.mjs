import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNTIME_ROLES = new Set(['all', 'web', 'worker'])
const FORCE_STOP_AFTER_MS = 250_000

export function resolveRuntimeRole(value) {
  const role = value?.trim() || 'all'
  if (!RUNTIME_ROLES.has(role)) {
    throw new Error(`Invalid MYCHAT_RUNTIME_ROLE "${role}"; expected all, web, or worker`)
  }
  return role
}

export function servicesForRuntimeRole(
  role,
  forwardedArgs = process.argv.slice(2),
  execPath = process.execPath,
) {
  const selectedRole = resolveRuntimeRole(role)
  const services = [
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

export async function startProduction(options = {}) {
  const environment = options.env ?? process.env
  const services = servicesForRuntimeRole(
    resolveRuntimeRole(environment.MYCHAT_RUNTIME_ROLE),
    options.forwardedArgs ?? process.argv.slice(2),
    options.execPath ?? process.execPath,
  )
  const spawnChild = options.spawnChild ?? spawn
  const children = services.map(service => ({
    ...service,
    child: spawnChild(service.command, service.args, {
      env: environment,
      stdio: 'inherit',
    }),
  }))

  let stopping = false
  let exitCode = 0
  let forceTimer

  function stop(signal = 'SIGTERM', code = 0) {
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

  const signalHandlers = new Map()
  for (const signal of ['SIGTERM', 'SIGINT']) {
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
    await Promise.all(children.map(({ child }) => new Promise(resolveClose => {
      child.once('close', resolveClose)
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
