type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>
export type IdleWaitOutcome = 'elapsed' | 'wake' | 'shutdown'

/** Coalesces best-effort enqueue notices and interrupts only idle waits. */
export class JobWorkerIdleWake {
  private readonly waits = new Set<AbortController>()
  private pending = false

  notify(): void {
    this.pending = true
    const idle = this.waits.values().next().value
    if (idle && !idle.signal.aborted) idle.abort()
  }

  clear(): void { this.pending = false }

  shutdown(reason: unknown): void {
    for (const idle of this.waits) {
      if (!idle.signal.aborted) idle.abort(reason)
    }
  }

  async wait(milliseconds: number, sleep: Sleep, shutdown: AbortSignal): Promise<IdleWaitOutcome> {
    if (this.consume()) return 'wake'
    if (shutdown.aborted) return 'shutdown'
    const idle = new AbortController()
    const stopIdle = () => idle.abort(shutdown.reason)
    shutdown.addEventListener('abort', stopIdle, { once: true })
    this.waits.add(idle)
    try {
      await sleep(milliseconds, idle.signal)
      if (shutdown.aborted) return 'shutdown'
      return this.consume() ? 'wake' : 'elapsed'
    } catch (error) {
      if (shutdown.aborted) return 'shutdown'
      if (!idle.signal.aborted) throw error
      this.consume()
      return 'wake'
    } finally {
      this.waits.delete(idle)
      shutdown.removeEventListener('abort', stopIdle)
    }
  }

  private consume(): boolean {
    if (!this.pending) return false
    this.pending = false
    return true
  }
}
