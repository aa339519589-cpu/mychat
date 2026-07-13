export type AgentExecutionEnvironment = {
  NODE_ENV?: string
  E2B_API_KEY?: string
  ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION?: string
  AGENT_SANDBOX_EGRESS_ALLOWLIST?: string
}

export type AgentExecutionBackend = "isolated" | "local" | "disabled"

const DEFAULT_SANDBOX_EGRESS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "*.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
  "nodejs.org",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
] as const
const PUBLIC_HOST_RULE = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z](?:[a-z0-9-]{0,62})$/

/** E2B egress is deny-by-default once allowOut is present. Only public host rules are accepted. */
export function sandboxEgressAllowlist(
  environment: AgentExecutionEnvironment = process.env,
): string[] {
  const configured = (environment.AGENT_SANDBOX_EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  for (const rule of configured) {
    if (!PUBLIC_HOST_RULE.test(rule)
      || rule.endsWith(".local")
      || rule.endsWith(".internal")
      || rule.endsWith(".localhost")) {
      throw new Error(`Invalid AGENT_SANDBOX_EGRESS_ALLOWLIST rule: ${rule}`)
    }
  }
  return [...new Set([...DEFAULT_SANDBOX_EGRESS, ...configured])]
}

function runtimeEnvironment(environment: AgentExecutionEnvironment): string {
  return environment.NODE_ENV?.trim().toLowerCase() ?? ""
}

export function isolatedSandboxConfigured(
  environment: AgentExecutionEnvironment = process.env,
): boolean {
  return Boolean(environment.E2B_API_KEY?.trim())
}

/** Host execution is an explicit development/test escape hatch, never a deployment fallback. */
export function localWorkspaceExecutionAllowed(
  environment: AgentExecutionEnvironment = process.env,
): boolean {
  const runtime = runtimeEnvironment(environment)
  return (runtime === "development" || runtime === "test")
    && environment.ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION === "true"
}

export function agentExecutionBackend(
  environment: AgentExecutionEnvironment = process.env,
): AgentExecutionBackend {
  if (isolatedSandboxConfigured(environment)) return "isolated"
  if (localWorkspaceExecutionAllowed(environment)) return "local"
  return "disabled"
}

export function productionAgentSandboxReady(
  environment: AgentExecutionEnvironment = process.env,
): boolean {
  return runtimeEnvironment(environment) !== "production"
    || isolatedSandboxConfigured(environment)
}

export function assertProductionAgentSandbox(
  environment: AgentExecutionEnvironment = process.env,
): void {
  if (!productionAgentSandboxReady(environment)) {
    throw new Error("Production agent execution requires a non-empty E2B_API_KEY")
  }
}
