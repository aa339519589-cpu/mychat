export type CodeApplyOutcome = {
  status: number
  body: Record<string, unknown>
}

export function applyOutcome(
  body: Record<string, unknown>,
  status = 200,
): CodeApplyOutcome {
  return { status, body }
}
