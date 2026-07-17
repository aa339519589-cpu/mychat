import { agentExecutionBackend } from '@/lib/agent/execution-policy'
import { createRecorder } from '@/lib/agent/recorder'
import { getChangedFiles } from '@/lib/agent/workspace'
import { advanceWorkspaceAuthority } from '@/lib/agent/workspace-authority'
import { buildCodeTools, createCodeToolExecutor } from '@/lib/code-tools'
import { createCodeEventCollector, createCodeRunProgress } from '@/lib/code-agent/runtime'
import type { ExecuteTool } from '@/lib/llm/agent-loop'
import type { ChatEvent } from '@/lib/llm/events'
import { JobRuntimeError } from '../errors'
import type { JobEventWriter } from '../event-writer'
import { executeFencedToolEffect } from '../tool-effects'
import type { JobExecutionContext } from '../worker'
import type { LoadedAgentJob } from './agent-input'

const SAFE_TOOLS = new Set(['list_files', 'search_files', 'read_file', 'git_diff', 'search', 'fetch_url'])
const CHECKPOINT_TOOLS = new Set(['write_files', 'edit_file', 'delete_files', 'apply_patch', 'execute', 'verify'])

export function createAgentRuntime(
  context: JobExecutionContext,
  input: LoadedAgentJob,
  writer: JobEventWriter,
) {
  const recorder = createRecorder({ supabase: input.client, userId: input.userId, taskId: input.taskId })
  const executionBackend = agentExecutionBackend()
  const hasWorkspace = input.workspaceReady && Boolean(input.repo)
  const canExecute = hasWorkspace && executionBackend !== 'disabled'
  const tools = buildCodeTools({
    isWorkspace: hasWorkspace,
    executePermission: executionBackend === 'isolated'
      ? '在当前任务独享的 Linux 沙箱中执行经过白名单审计的命令'
      : '在 workspace 中执行受控命令',
    canExecute,
    allowExternalNetwork: !input.repoIsPrivate,
  })
  const events = createCodeEventCollector({
    send: event => writer.emit(event as ChatEvent),
    recordStep: (kind, label) => { void recorder.step(kind, label) },
  })
  const workspaceHasChanges = () => {
    if (!hasWorkspace) return false
    const changed = getChangedFiles(input.taskId, input.userId)
    return changed.ok && changed.data.files.length > 0
  }
  const progress = createCodeRunProgress(workspaceHasChanges)
  const executeImpl = createCodeToolExecutor({
    repo: input.repo,
    login: input.login,
    token: input.token,
    defaultBranch: input.defaultBranch,
    repoIsPrivate: input.repoIsPrivate,
    supabase: input.client,
    userId: input.userId,
    wsReady: hasWorkspace,
    wsTaskId: input.taskId,
    wsUserId: input.userId,
    tavilyApiKey: process.env.TAVILY_API_KEY ?? '',
    emit: events.emit,
    signal: context.signal,
    canExecute,
    state: progress.toolState,
    sandboxTimeoutMs: () => context.budget.remainingSandboxTimeMs(),
  })
  const executeTool: ExecuteTool = async (name, args, execution) => {
    context.budget.consumeToolCall()
    const startedAt = Date.now()
    const toolCallId = execution?.toolCallId
    if (!toolCallId) throw new JobRuntimeError('JOB_INVALID_INPUT', 'Provider tool call id is missing')
    await writer.append('tool.requested', { toolCallId, toolName: name }, `${toolCallId}:requested`)
    const effect = await executeFencedToolEffect({
      client: input.client,
      fence: context.fence,
      toolCallId,
      toolName: name,
      args,
      replaySafe: SAFE_TOOLS.has(name),
      execute: () => recorder.recordToolCall(name, args, () => executeImpl(name, args)),
    })
    if (!effect.replayed && (name === 'execute' || name === 'verify')) {
      context.budget.reportSandboxTime(Date.now() - startedAt)
    }
    const dryRun = name === 'apply_patch' && args && typeof args === 'object'
      && !Array.isArray(args) && (args as { dryRun?: unknown }).dryRun === true
    if (hasWorkspace && CHECKPOINT_TOOLS.has(name) && !dryRun) {
      await advanceWorkspaceAuthority(
        context, input.client, input.userId, input.taskId, `after-tool:${toolCallId}`,
      )
    }
    await writer.append('tool.completed', {
      toolCallId,
      toolName: name,
      replayed: effect.replayed,
    }, `${toolCallId}:completed`)
    return effect.result
  }
  return { recorder, canExecute, tools, events, progress, executeTool }
}
