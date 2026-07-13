import { spawn } from 'node:child_process'

const services = [
  {
    name: 'web',
    command: process.execPath,
    args: ['node_modules/next/dist/bin/next', 'start'],
  },
  {
    name: 'worker',
    command: process.execPath,
    args: ['--import', 'tsx', 'job-worker.ts'],
  },
]

const children = services.map(service => ({
  ...service,
  child: spawn(service.command, service.args, {
    env: process.env,
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
  }, 250_000)
  forceTimer.unref()
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => stop(signal, 0))
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

await Promise.all(children.map(({ child }) => new Promise(resolve => {
  child.once('close', resolve)
})))

if (forceTimer) clearTimeout(forceTimer)
process.exitCode = exitCode
