import { execFile } from "node:child_process"
import { isolatedGitEnvironment } from "../git-environment"

export type GitCommandOptions = {
  cwd: string
  timeoutMs: number
  maxBuffer?: number
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

/** Run Git without blocking the worker event loop that renews the job lease. */
export function runGit(args: readonly string[], options: GitCommandOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile("git", [...args], {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 1024 * 1024,
        encoding: "utf-8",
        env: isolatedGitEnvironment(options.env),
        signal: options.signal,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout)
          return
        }
        const commandError = error as Error & { stdout?: string; stderr?: string }
        commandError.stdout = stdout
        commandError.stderr = stderr
        reject(commandError)
      })
    } catch (error) {
      reject(error)
    }
  })
}
