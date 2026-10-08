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
import { codePlanToolAllowed, executeCodePlanTool } from '@/lib/code-agent/plan-policy'
import type { CodeMcpBroker } from '@/lib/code-tools/mcp-broker'

const SAFE_TOOLS = new Set(['list_files', 'search_files', 'read_file', 'git_diff', 'search', 'fetch_url'])
const CHECKPOINT_TOOLS = new Set(['write_files', 'edit_file', 'delete_files', 'apply_patch', 'execute', 'verify'])

function createWorkspaceToolExecutor(
  context: JobExecutionContext,
  input: LoadedAgentJob,
  hasWorkspace: boolean,
  canExecute: boolean,
  events: ReturnType<typeof createCodeEventCollector>,
  progress: ReturnType<typeof createCodeRunProgress>,
  mcpBroker?: CodeMcpBroker,
) {
  return createCodeToolExecutor({
    mcpBroker,
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
    memoryEnabled: input.memoryEnabled,
    sensitiveMemoryEnabled: input.sensitiveMemoryEnabled,
    state: progress.toolState,
    sandboxTimeoutMs: () => context.budget.remainingSandboxTimeMs(),
  })
}

export function createAgentRuntime(
  context: JobExecutionContext,
  input: LoadedAgentJob,
  writer: JobEventWriter,
  mcpBroker?: CodeMcpBroker,
) {
  const recorder = createRecorder({ supabase: input.client, userId: input.userId, taskId: input.taskId })
  const executionBackend = agentExecutionBackend()
  const readOnlyPlan = input.readOnlyPlan === true
  const hasWorkspace = input.workspaceReady && Boolean(input.repo)
  const canExecute = !readOnlyPlan && hasWorkspace && executionBackend !== 'disabled'
  const tools = buildCodeTools({
    remoteTools: mcpBroker?.listTools(),
    isWorkspace: hasWorkspace,
    executePermission: executionBackend === 'isolated'
      ? '在当前任务独享的 Linux 沙箱中执行经过白名单审计的命令'
      : '在 workspace 中执行受控命令',
    canExecute,
    allowExternalNetwork: !input.repoIsPrivate,
    memoryEnabled: input.memoryEnabled && Boolean(input.userId && input.client),
  }).filter(tool => !readOnlyPlan || codePlanToolAllowed(tool.function.name)
    || mcpBroker?.listTools().some(metadata => metadata.toolId === tool.function.name && !metadata.approvalRequired))
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
  const executeImpl = createWorkspaceToolExecutor(context, input, hasWorkspace, canExecute, events, progress, mcpBroker)
  const executeTool: ExecuteTool = async (name, args, execution) => {
    context.signal.throwIfAborted()
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
      execute: () => recorder.recordToolCall(name, args, () => readOnlyPlan && !name.startsWith('mcp_')
        ? executeCodePlanTool(name, () => executeImpl(name, args), progress.toolState.markCompleted)
        : executeImpl(name, args)),
    })
    if (!effect.replayed && (name === 'execute' || name === 'verify')) {
      context.budget.reportSandboxTime(Date.now() - startedAt)
    }
    const dryRun = name === 'apply_patch' && args && typeof args === 'object'
      && !Array.isArray(args) && (args as { dryRun?: unknown }).dryRun === true
    if (!readOnlyPlan && hasWorkspace && CHECKPOINT_TOOLS.has(name) && !dryRun) {
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
