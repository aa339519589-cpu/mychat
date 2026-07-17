import { classifyFileRisk } from "../risk"
import { isolatedGitEnvironment } from "../git-environment"
import { runGit } from "./git-command"

const AGENT_GIT_NAME = "mychat-agent"
const AGENT_GIT_EMAIL = "mychat-agent@users.noreply.github.com"

export function checkRiskFiles(files: string[]): { blocked: string[]; warnings: string[] } {
  const risk = classifyFileRisk(files)
  return {
    blocked: risk.blocked ? risk.files : [],
    warnings: risk.needsConfirmation ? risk.files : [],
  }
}

function gitCommitEnv(): NodeJS.ProcessEnv {
  return isolatedGitEnvironment({
    GIT_AUTHOR_NAME: AGENT_GIT_NAME,
    GIT_AUTHOR_EMAIL: AGENT_GIT_EMAIL,
    GIT_COMMITTER_NAME: AGENT_GIT_NAME,
    GIT_COMMITTER_EMAIL: AGENT_GIT_EMAIL,
  })
}

export function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  const credentials = Buffer.from(`x-access-token:${token}`).toString("base64")
  return isolatedGitEnvironment({
    ...gitCommitEnv(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
  })
}

export async function ensureWorkspaceGitIdentity(
  root: string,
  signal?: AbortSignal,
): Promise<NodeJS.ProcessEnv> {
  const env = gitCommitEnv()
  await runGit(["config", "user.name", AGENT_GIT_NAME], {
    cwd: root,
    timeoutMs: 5000,
    env,
    signal,
  })
  await runGit(["config", "user.email", AGENT_GIT_EMAIL], {
    cwd: root,
    timeoutMs: 5000,
    env,
    signal,
  })
  return env
}

export function isValidGitHubRepository(repo: string): boolean {
  if (repo.length > 201 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return false
  const [owner, name] = repo.split("/")
  return Boolean(owner && name && owner !== "." && owner !== ".." && name !== "." && name !== "..")
}

export function commandError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "")
  const record = error as { stderr?: unknown; message?: unknown }
  return String(record.stderr ?? record.message ?? "")
}
