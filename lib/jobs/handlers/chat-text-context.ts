import { appendUserSystemPrompt } from '@/lib/chat/request-context'
import { buildSystem } from '@/lib/llm/system'
import { activeTools, type ToolContext } from '@/lib/tools'
import type { JobExecutionContext } from '../worker'
import type { LoadedChatJob } from './chat-input'

export type ActiveChatTools = ReturnType<typeof activeTools>

type ChatMemoryPolicy<Memory> = {
  enabled: boolean
  globalMemories: Memory[] | undefined
}

export function resolveChatMemoryPolicy<Memory>(input: {
  customEndpoint: boolean
  memoryEnabled: boolean
  inProject: boolean
  memories: Memory[]
}): ChatMemoryPolicy<Memory> {
  const enabled = input.memoryEnabled && (!input.customEndpoint || !input.inProject)
  return {
    enabled,
    globalMemories: enabled && !input.inProject ? input.memories : undefined,
  }
}

export function buildChatTools(
  context: JobExecutionContext,
  input: LoadedChatJob,
  latestBeijingDate: string | null,
  instant: boolean,
): { tools: ActiveChatTools; toolContext: ToolContext } {
  const { selection, command } = input
  const projectId = input.context.project?.id ?? null
  const memoryPolicy = resolveChatMemoryPolicy({
    customEndpoint: selection.customEndpoint,
    memoryEnabled: input.context.memoryEnabled,
    inProject: Boolean(projectId),
    memories: input.context.memories,
  })
  return {
    tools: instant ? [] : activeTools({
      loggedIn: true,
      searchMode: command.searchMode,
      memoryEnabled: memoryPolicy.enabled,
      projectId: selection.customEndpoint ? null : projectId,
    }),
    toolContext: {
      supabase: input.client,
      userId: input.userId,
      projectId,
      searchMode: command.searchMode,
      latestBeijingDate,
      signal: context.signal,
    },
  }
}

export function buildChatSystem(
  input: LoadedChatJob,
  latestBeijingDate: string | null,
  historyContext: string,
): string {
  const { selection, command } = input
  const { memories, memoryEnabled, project } = input.context
  const memoryPolicy = resolveChatMemoryPolicy({
    customEndpoint: selection.customEndpoint,
    memoryEnabled,
    inProject: Boolean(project?.id),
    memories,
  })
  const backendSystem = buildSystem(memoryPolicy.globalMemories, {
    searchMode: command.searchMode,
    latestBeijingDate,
    memoryEnabled: memoryPolicy.enabled,
    project: selection.customEndpoint ? undefined : project,
    modelSource: selection.customEndpoint ? 'custom' : 'platform',
    tierLabel: selection.customEndpoint ? null : selection.platformTierLabel,
    modelId: selection.customEndpoint ? selection.model : null,
    endpointName: selection.customEndpoint ? selection.endpointDisplayName : null,
    renderRules: input.command.renderEnabled,
  }) + historyContext
  return appendUserSystemPrompt(backendSystem, input.context.customSystemPrompt)
}
