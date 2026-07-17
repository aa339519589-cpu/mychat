import type { SupabaseClient } from "@/lib/supabase/types"

import { addStep, getTaskDetail, updateTaskStatus } from "../data"
import {
  commitWorkspaceChanges,
  getWorkspaceGitStatus,
  pushAgentBranch,
} from "./git-operations"
import { createWorkspacePullRequest } from "./pull-request"
import type { CommitResult, GitStatus, PublishResult } from "./types"

type ResumableTask = {
  commitSha?: string | null
  pullRequestUrl?: string | null
}

export function canResumeCommittedPublish(status: GitStatus, task: ResumableTask): boolean {
  return !status.hasChanges
    && !!task.commitSha
    && task.commitSha === status.commitSha
    && !task.pullRequestUrl
}

export async function publishWorkspaceToPullRequest(
  taskId: string,
  userId: string,
  githubToken: string,
  supabase: SupabaseClient,
  options: {
    message?: string
    title?: string
    body?: string
    base?: string
    signal?: AbortSignal
  } = {},
): Promise<PublishResult> {
  const taskDetail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in taskDetail)) {
    return { ok: false, error: "任务不存在", stage: "task" }
  }

  const status = await getWorkspaceGitStatus(taskId, userId, options.signal)
  if (!status.ok) return { ok: false, error: status.error, stage: "status" }
  const canResume = canResumeCommittedPublish(status, taskDetail)
  if (!status.hasChanges && !canResume) {
    return { ok: false, error: "没有可提交的改动", stage: "status", status }
  }

  const currentUpdatedAt = new Date(taskDetail.updatedAt).getTime()
  if (taskDetail.status === "creating_pr" && Date.now() - currentUpdatedAt < 5 * 60_000) {
    return { ok: false, error: "发布正在进行，请勿重复提交", stage: "lock", status }
  }
  let claimQuery = supabase
    .from("agent_tasks")
    .update({ status: "creating_pr", error: null, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("user_id", userId)
  claimQuery = taskDetail.status === "creating_pr"
    ? claimQuery.eq("status", "creating_pr").eq("updated_at", taskDetail.updatedAt)
    : claimQuery.neq("status", "creating_pr")
  const { data: claimed, error: claimError } = await claimQuery
    .select("id")
    .maybeSingle()
  if (claimError || !claimed) {
    return { ok: false, error: "发布正在进行，请勿重复提交", stage: "lock", status }
  }

  await addStep(supabase, userId, taskId, {
    kind: "info",
    label: "开始发布",
    detail: `${status.changedFiles?.length ?? 0} 个待提交文件`,
  })

  const message = options.message
    || `Agent: ${taskDetail.goal.slice(0, 60) || "code changes"}`
  let commit: CommitResult
  if (canResume) {
    commit = {
      ok: true,
      commitSha: taskDetail.commitSha!,
      message,
      changedFiles: [],
    }
  } else {
    commit = await commitWorkspaceChanges(taskId, userId, message, supabase, options.signal)
    if (!commit.ok) {
      await updateTaskStatus(supabase, userId, taskId, "failed", { error: commit.error })
      return { ok: false, error: commit.error, stage: "commit", status, commit }
    }
  }

  const push = await pushAgentBranch(taskId, userId, githubToken, supabase, options.signal)
  if (!push.ok) {
    await updateTaskStatus(supabase, userId, taskId, "failed", { error: push.error })
    return { ok: false, error: push.error, stage: "push", status, commit, push }
  }

  const pullRequest = await createWorkspacePullRequest(
    taskId,
    userId,
    githubToken,
    supabase,
    {
      title: options.title,
      body: options.body,
      base: options.base,
      signal: options.signal,
    },
  )
  if (!pullRequest.ok) {
    await updateTaskStatus(supabase, userId, taskId, "failed", { error: pullRequest.error })
    return {
      ok: false,
      error: pullRequest.error,
      stage: "pr",
      status,
      commit,
      push,
      pr: pullRequest,
    }
  }

  console.warn(`Publish complete: ${pullRequest.pullRequestUrl}`)
  return { ok: true, status, commit, push, pr: pullRequest }
}
