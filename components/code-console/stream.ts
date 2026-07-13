import type { CodeStep, PlanAction } from "@/lib/code-data"

export type CodeStreamEvent = { done: true } | { data: Record<string, unknown> }

export type CodeStreamState = {
  taskId: string | null
  steps: CodeStep[]
  plan: PlanAction[]
  fullText: string
  hadError: boolean
  streamDone: boolean
  publishPending: boolean
}

export function initialCodeStreamState(taskId: string | null): CodeStreamState {
  return {
    taskId,
    steps: [],
    plan: [],
    fullText: "",
    hadError: false,
    streamDone: false,
    publishPending: false,
  }
}

/** Apply the backend event precedence used by the Code console. */
export function reduceCodeStreamEvent(state: CodeStreamState, event: CodeStreamEvent): CodeStreamState {
  if ("done" in event) return { ...state, streamDone: true }
  const data = event.data
  if (typeof data.taskId === "string" && data.taskId) {
    return { ...state, taskId: data.taskId }
  }
  if (data.step) {
    const step = data.step as CodeStep
    return {
      ...state,
      steps: [...state.steps, step],
      publishPending: state.publishPending
        || (step.kind === "deploy" && step.label === "准备发布"),
    }
  }
  if (data.plan) {
    return { ...state, plan: [...state.plan, data.plan as PlanAction] }
  }
  if (typeof data.text === "string" && data.text) {
    const fullText = state.fullText + data.text
    return {
      ...state,
      fullText,
      publishPending: state.publishPending || fullText.includes("确认发布"),
    }
  }
  if (typeof data.error === "string" && data.error) {
    return { ...state, fullText: data.error, hadError: true }
  }
  return state
}
