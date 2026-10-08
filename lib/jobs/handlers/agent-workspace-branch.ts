import { runGit } from '@/lib/agent/git-publish/git-command'
import { workspaceRoot } from '@/lib/agent/workspace-paths'
import { JobRuntimeError } from '../errors'
import type { JobExecutionContext } from '../worker'

export async function currentWorkspaceBranch(context: JobExecutionContext,
  value: { taskId: string; userId: string }, taskBranch: string | null, createdBranch: string | null): Promise<string> {
  if (taskBranch) return taskBranch
  if (createdBranch) return createdBranch
  try {
    return (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspaceRoot(value.taskId, value.userId), timeoutMs: 10_000, signal: context.signal,
    })).trim()
  } catch {
    context.signal.throwIfAborted()
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Workspace branch cannot be determined')
  }
}
