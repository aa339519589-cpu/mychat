import type { CodeStreamState } from "./stream"

type TimerHandle = ReturnType<typeof setTimeout>

type SmoothCodeStreamRendererOptions = {
  initialState: CodeStreamState
  render: (previous: CodeStreamState, state: CodeStreamState) => void
  intervalMs?: number
}

export type SmoothCodeStreamRenderer = {
  push: (state: CodeStreamState) => void
  finish: (state: CodeStreamState) => Promise<void>
  cancel: () => void
}

const DEFAULT_INTERVAL_MS = 5

export function visibleCharactersPerTick(backlog: number, finishing: boolean): number {
  if (backlog <= 0) return 0
  if (finishing) {
    if (backlog > 128) return 8
    if (backlog > 64) return 4
    if (backlog > 32) return 2
    return 1
  }
  if (backlog > 128) return 4
  if (backlog > 64) return 2
  return 1
}

class CodeCharacterStreamRenderer implements SmoothCodeStreamRenderer {
  private latestState: CodeStreamState
  private renderedState: CodeStreamState
  private visibleText: string
  private targetText: string
  private timer: TimerHandle | null = null
  private finishing = false
  private cancelled = false
  private drainResolvers: Array<() => void> = []
  private readonly intervalMs: number
  private readonly renderCallback: SmoothCodeStreamRendererOptions["render"]

  constructor(options: SmoothCodeStreamRendererOptions) {
    this.latestState = options.initialState
    this.renderedState = options.initialState
    this.visibleText = options.initialState.fullText
    this.targetText = options.initialState.fullText
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.renderCallback = options.render
  }

  push = (state: CodeStreamState): void => {
    if (this.cancelled) return
    this.latestState = state
    this.targetText = state.fullText
    if (state.hadError || !this.targetText.startsWith(this.visibleText)) {
      this.showImmediately()
      return
    }
    if (this.visibleText === this.targetText) {
      this.render()
      this.resolveDrains()
      return
    }
    this.schedule()
  }

  finish = (state: CodeStreamState): Promise<void> => {
    this.finishing = true
    this.push(state)
    if (this.visibleText === this.targetText && !this.timer) return Promise.resolve()
    return new Promise(resolve => {
      this.drainResolvers.push(resolve)
      this.schedule()
    })
  }

  cancel = (): void => {
    this.cancelled = true
    this.clearTimer()
    this.releaseResolvers()
  }

  private showImmediately(): void {
    this.clearTimer()
    this.visibleText = this.targetText
    this.render()
    this.resolveDrains()
  }

  private render(): void {
    const nextState = { ...this.latestState, fullText: this.visibleText }
    this.renderCallback(this.renderedState, nextState)
    this.renderedState = nextState
  }

  private schedule(): void {
    if (this.cancelled || this.timer || this.visibleText === this.targetText) {
      this.resolveDrains()
      return
    }
    this.timer = setTimeout(this.tick, this.intervalMs)
  }

  private tick = (): void => {
    this.timer = null
    if (this.cancelled) return
    if (!this.targetText.startsWith(this.visibleText)) {
      this.showImmediately()
      return
    }
    const remaining = Array.from(this.targetText.slice(this.visibleText.length))
    const count = visibleCharactersPerTick(remaining.length, this.finishing)
    this.visibleText += remaining.slice(0, count).join("")
    this.render()
    if (this.visibleText === this.targetText) this.resolveDrains()
    else this.schedule()
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private resolveDrains(): void {
    if (this.visibleText !== this.targetText || this.timer) return
    this.releaseResolvers()
  }

  private releaseResolvers(): void {
    const resolvers = this.drainResolvers
    this.drainResolvers = []
    for (const resolve of resolvers) resolve()
  }
}

export function createSmoothCodeStreamRenderer(
  options: SmoothCodeStreamRendererOptions,
): SmoothCodeStreamRenderer {
  return new CodeCharacterStreamRenderer(options)
}
