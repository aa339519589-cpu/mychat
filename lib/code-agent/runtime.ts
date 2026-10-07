import type { AgentTaskStatus } from '@/lib/agent/types'
import type { ChatEvent, Emit } from '@/lib/llm/events'
import type { TurnResult } from '@/lib/llm/turn'
import type { ChatModelSelection } from '@/lib/chat/model-selection'

export function shouldReserveCodeTrial(
  selection: Pick<ChatModelSelection, 'customEndpoint' | 'accessClass'>,
  isOwner: boolean,
): boolean {
  return !selection.customEndpoint && selection.accessClass === 'trial' && !isOwner
}

export function isCodeReplyComplete(
  progress: CodeProgressSnapshot,
  turn: Pick<TurnResult, 'failed' | 'truncated' | 'leaked' | 'hasIncompleteToolCall' | 'toolCalls' | 'content'>,
): boolean {
  return !progress.usedTools && !progress.hasChanges && !progress.plannedRepo
    && progress.plannedFiles === 0 && !turn.failed && !turn.truncated
    && !turn.leaked && !turn.hasIncompleteToolCall && turn.toolCalls.length === 0
    && turn.content.trim().length > 0
}

export type CodeProgressSnapshot = {
  workspace: boolean
  usedTools: boolean
  hasChanges: boolean
  published: boolean
  completed: boolean
  waitingForUser: boolean
  plannedRepo: boolean
  plannedFiles: number
}

export function createCodeRunProgress(workspaceHasChanges: () => boolean) {
  let usedTools = false
  let publishCalled = false
  let completed = false
  let waitingForUser = false
  let plannedRepo = false
  let plannedFiles = 0
  let verifiedDiff: string | null = null

  return {
    toolState: {
      markUsedTool: () => { usedTools = true },
      hasUsedTools: () => usedTools,
      markPlannedRepo: () => { plannedRepo = true },
      hasPlannedRepo: () => plannedRepo,
      addPlannedFiles: (count = 1) => { plannedFiles += count },
      getPlannedFiles: () => plannedFiles,
      markPublishCalled: () => { publishCalled = true },
      hasPublishCalled: () => publishCalled,
      markCompleted: () => { completed = true },
      markWaitingForUser: () => { waitingForUser = true },
      getVerifiedDiff: () => verifiedDiff,
      setVerifiedDiff: (diff: string | null) => { verifiedDiff = diff },
      workspaceHasChanges,
    },
    snapshot: (workspace: boolean): CodeProgressSnapshot => ({
      workspace,
      usedTools,
      hasChanges: workspaceHasChanges(),
      published: publishCalled,
      completed,
      waitingForUser,
      plannedRepo,
      plannedFiles,
    }),
  }
}

export function finalCodeTaskStatus(
  loopFailed: boolean,
  progress: Pick<CodeProgressSnapshot,
    'completed' | 'waitingForUser' | 'published' | 'workspace' | 'plannedRepo' | 'plannedFiles'>,
): AgentTaskStatus {
  if (loopFailed) return 'failed'
  if (progress.completed) return 'completed'
  if (progress.waitingForUser || progress.published) return 'waiting_for_user'
  if (!progress.workspace && progress.plannedRepo && progress.plannedFiles > 0) {
    return 'waiting_for_user'
  }
  return 'running'
}

/** Forward every accepted model text delta immediately; no lead-text holdback. */
export function createCodeEventCollector(options: {
  send: (event: object) => void
  recordStep?: (kind: string, label: string) => void
}) {
  let finalText = ''

  const emit: Emit = (event: ChatEvent) => {
    if ('thinking' in event) return
    if ('text' in event) finalText += event.text
    if ('error' in event) finalText = `${finalText}${finalText ? '\n\n' : ''}${event.error}`
    if ('step' in event) options.recordStep?.(event.step.kind, event.step.label)
    options.send(event)
  }

  return { emit, getFinalText: () => finalText }
}
