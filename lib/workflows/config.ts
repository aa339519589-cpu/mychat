export const WORKFLOW_RUNTIME_MODES = ['postgres-v1', 'legacy'] as const
export type WorkflowRuntimeMode = typeof WORKFLOW_RUNTIME_MODES[number]

export function workflowRuntimeMode(value = process.env.MYCHAT_WORKFLOW_RUNTIME): WorkflowRuntimeMode {
  const mode = value?.trim() || 'postgres-v1'
  if ((WORKFLOW_RUNTIME_MODES as readonly string[]).includes(mode)) return mode as WorkflowRuntimeMode
  throw new TypeError('MYCHAT_WORKFLOW_RUNTIME must be postgres-v1 or legacy')
}
