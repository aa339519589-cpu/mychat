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

const DEFAULT_INTERVAL_MS = 8

export function visibleCharactersPerTick(backlog: number, finishing: boolean): number {
  if (backlog <= 0) return 0
  if (finishing) {
    if (backlog > 96) return 12
    if (backlog > 48) return 6
    if (backlog > 20) return 3
    if (backlog > 10) return 2
    return 1
  }
  if (backlog > 96) return 8
  if (backlog > 48) return 4
  if (backlog > 16) return 2
  return 1
}

export function createSmoothCodeStreamRenderer(
  options: SmoothCodeStreamRendererOptions,
): SmoothCodeStreamRenderer {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  let latestState = options.initialState
  let renderedState = options.initialState
  let visibleText = options.initialState.fullText
  let targetText = options.initialState.fullText
  let timer: TimerHandle | null = null
  let finishing = false
  let cancelled = false
  let drainResolvers: Array<() => void> = []

  const resolveDrains = () => {
    if (visibleText !== targetText || timer) return
    const resolvers = drainResolvers
    drainResolvers = []
    for (const resolve of resolvers) resolve()
  }

  const render = () => {
    const nextState = { ...latestState, fullText: visibleText }
    options.render(renderedState, nextState)
    renderedState = nextState
  }

  const clearTimer = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const schedule = () => {
    if (cancelled || timer || visibleText === targetText) {
      resolveDrains()
      return
    }
    timer = setTimeout(() => {
      timer = null
      if (cancelled) return
      if (!targetText.startsWith(visibleText)) {
        visibleText = targetText
        render()
        resolveDrains()
        return
      }
      const remaining = Array.from(targetText.slice(visibleText.length))
      const count = visibleCharactersPerTick(remaining.length, finishing)
      visibleText += remaining.slice(0, count).join("")
      render()
      if (visibleText === targetText) resolveDrains()
      else schedule()
    }, intervalMs)
  }

  const push = (state: CodeStreamState) => {
    if (cancelled) return
    latestState = state
    targetText = state.fullText

    if (state.hadError || !targetText.startsWith(visibleText)) {
      clearTimer()
      visibleText = targetText
      render()
      resolveDrains()
      return
    }

    if (visibleText === targetText) {
      render()
      resolveDrains()
      return
    }
    schedule()
  }

  const finish = (state: CodeStreamState): Promise<void> => {
    finishing = true
    push(state)
    if (visibleText === targetText && !timer) return Promise.resolve()
    return new Promise(resolve => {
      drainResolvers.push(resolve)
      schedule()
    })
  }

  const cancel = () => {
    cancelled = true
    clearTimer()
    const resolvers = drainResolvers
    drainResolvers = []
    for (const resolve of resolvers) resolve()
  }

  return { push, finish, cancel }
}
