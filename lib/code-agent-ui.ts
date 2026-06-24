import type { CodeMessage } from "@/lib/code-data"

type PublishTaskState = {
  status?: string | null
  pullRequestUrl?: string | null
  steps?: { kind?: string | null; label?: string | null }[] | null
}

const PUBLISH_CUES = [
  "等待用户确认发布",
  "请点击底部确认发布",
  "请点击底部「确认发布」按钮",
  "请点击底部“确认发布”按钮",
]

function includesPublishCue(content: string): boolean {
  return PUBLISH_CUES.some(cue => content.includes(cue))
}

export function inferPublishPendingFromMessages(messages: CodeMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.result?.mode === "workspace_pr" || msg.result?.pullRequestUrl || msg.result?.commitSha) {
      return false
    }
    if (msg.role === "assistant" && includesPublishCue(msg.content)) {
      return true
    }
  }
  return false
}

export function shouldShowWorkspacePublish(
  task: PublishTaskState | null,
  messages: CodeMessage[],
  workspaceDirty: boolean,
): boolean {
  if (workspaceDirty) return true
  if (task?.pullRequestUrl) return false

  const messageCue = inferPublishPendingFromMessages(messages)
  if (!task) return messageCue

  const waitingForUser = task.status === "waiting_for_user"
  const preparedToPublish = (task.steps ?? []).some(step => step?.kind === "deploy" && step?.label === "准备发布")

  return messageCue || (waitingForUser && preparedToPublish)
}
