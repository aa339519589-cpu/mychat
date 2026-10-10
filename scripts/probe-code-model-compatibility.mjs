// Retired diagnostic. Historical evidence is retained in workflow logs.
// This entrypoint intentionally performs zero network or model requests.
console.error('CODE_MODEL_COMPATIBILITY_DIAG ' + JSON.stringify({
  ok: false,
  historicalOnly: true,
  historicalHttpStatus: 402,
  modelRequestCount: 0,
  replacementModel: 'anthropic/claude-haiku-5.5',
  reasoningEffort: 'medium',
  mode: 'code',
  acceptanceScript: 'scripts/probe-cloud-code-workspace.mjs',
}))
process.exitCode = 1
