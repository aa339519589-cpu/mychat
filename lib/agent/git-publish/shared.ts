import { execFileSync } from "child_process"

import { classifyFileRisk } from "../risk"

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
  return {
    ...process.env,
    GIT_AUTHOR_NAME: AGENT_GIT_NAME,
    GIT_AUTHOR_EMAIL: AGENT_GIT_EMAIL,
    GIT_COMMITTER_NAME: AGENT_GIT_NAME,
    GIT_COMMITTER_EMAIL: AGENT_GIT_EMAIL,
  }
}

export function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  const credentials = Buffer.from(`x-access-token:${token}`).toString("base64")
  return {
    ...gitCommitEnv(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
  }
}

export function ensureWorkspaceGitIdentity(root: string): NodeJS.ProcessEnv {
  const env = gitCommitEnv()
  execFileSync("git", ["config", "user.name", AGENT_GIT_NAME], {
    cwd: root,
    timeout: 5000,
    encoding: "utf-8",
    env,
  })
  execFileSync("git", ["config", "user.email", AGENT_GIT_EMAIL], {
    cwd: root,
    timeout: 5000,
    encoding: "utf-8",
    env,
  })
  return env
}

export function isValidGitHubRepository(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
}

export function commandError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "")
  const record = error as { stderr?: unknown; message?: unknown }
  return String(record.stderr ?? record.message ?? "")
}
