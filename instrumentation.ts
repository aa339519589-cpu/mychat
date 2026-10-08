export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startProcessLiveRelay } = await import('./lib/jobs/process-live-events')
    startProcessLiveRelay()
  }
}
