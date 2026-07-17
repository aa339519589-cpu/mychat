import {
  streamJobEvents,
  type AcceptedJob,
  type JobStreamEnvelope,
} from "@/components/literary-chat/job-stream-client"
import type { ApplyResult } from "@/lib/code-data"
import { isSafeExternalHttpUrl } from "@/lib/external-url"
import { isJobStatus } from "@/lib/jobs/contracts"
import { isRecord } from "@/lib/unknown-value"
import { isUuid } from "@/lib/validation"

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>
type EventStreamer = (
  accepted: AcceptedJob,
  signal: AbortSignal,
  deadlineMs?: number,
) => AsyncIterable<JobStreamEnvelope>

export type CodeApplyOperationDependencies = {
  fetcher?: Fetcher
  confirm?: (message: string) => boolean
  streamEvents?: EventStreamer
}

type ConfirmationChallenge = {
  id: string
  token: string
  prompt: string
}

type HttpResult = { response: Response; data: unknown }

const TEXT_FIELDS = [
  "repo", "commitSha", "branch", "mergeCommitSha", "pagesError", "message",
] as const
const URL_FIELDS = ["repoUrl", "pagesUrl", "pullRequestUrl"] as const
const BOOLEAN_FIELDS = ["created", "merged"] as const
const RESULT_FIELDS = [...TEXT_FIELDS, ...URL_FIELDS, ...BOOLEAN_FIELDS,
  "mode", "pullRequestNumber", "pagesStatus"] as const

function boundedText(value: unknown, fallback: string, maximum = 500): string {
  if (typeof value !== "string") return fallback
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim()
  return normalized ? normalized.slice(0, maximum) : fallback
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null)
}

async function postApply(
  body: Record<string, unknown>,
  signal: AbortSignal,
  fetcher: Fetcher,
): Promise<HttpResult> {
  const response = await fetcher("/api/code/apply", {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return { response, data: await responseJson(response) }
}

function confirmationChallenge(result: HttpResult): ConfirmationChallenge | null {
  if (result.response.status !== 409 || !isRecord(result.data)
    || result.data.needsConfirmation !== true) return null
  const { confirmationId, confirmationToken, operation } = result.data
  if (!isUuid(confirmationId) || typeof confirmationToken !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(confirmationToken) || operation !== "publish") {
    throw new Error("发布确认响应无效")
  }
  const risk = isRecord(result.data.risk) ? result.data.risk : null
  const title = boundedText(risk?.title, "高风险发布", 120)
  const reason = boundedText(risk?.reason ?? result.data.error, "请确认是否继续", 500)
  return { id: confirmationId, token: confirmationToken, prompt: `${title}\n\n${reason}` }
}

async function submitConfirmation(
  challenge: ConfirmationChallenge,
  taskId: string,
  accepted: boolean,
  fetcher: Fetcher,
): Promise<void> {
  const response = await fetcher(`/api/agent/tasks/${encodeURIComponent(taskId)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: accepted ? "confirm" : "reject",
      operation: "publish",
      confirmationId: challenge.id,
      confirmationToken: challenge.token,
      reason: accepted ? undefined : "用户取消发布",
    }),
  })
  if (!accepted) throw new Error(response.ok ? "已取消高风险发布" : "拒绝确认失败")
  if (!response.ok) {
    const failure = await responseJson(response)
    throw new Error(isRecord(failure)
      ? boundedText(failure.error, "确认失败")
      : "确认失败")
  }
}

function acceptedJob(value: unknown): AcceptedJob {
  if (!isRecord(value) || !isUuid(value.jobId) || !isJobStatus(value.status)
    || typeof value.streamUrl !== "string") throw new Error("发布作业入队响应无效")
  const expectedUrl = `/api/v1/jobs/${value.jobId}/events?from_seq=0`
  if (value.streamUrl !== expectedUrl) throw new Error("发布作业事件流地址无效")
  return { jobId: value.jobId, streamUrl: value.streamUrl, status: value.status }
}

function optionalFieldsValid(
  value: Record<string, unknown>,
  fields: readonly string[],
  predicate: (field: unknown) => boolean,
): boolean {
  return fields.every(field => value[field] === undefined || predicate(value[field]))
}

function validMode(value: unknown): boolean {
  return value === "workspace_pr" || value === "direct_push"
}

function validPullRequestNumber(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) > 0)
}

function validPagesStatus(value: unknown): boolean {
  return value === undefined || value === "ready" || value === "pending" || value === "failed"
}

function validApplyResultFields(value: Record<string, unknown>): boolean {
  const checks = [
    optionalFieldsValid(value, TEXT_FIELDS,
      field => typeof field === "string" && field.length <= 10_000 && !field.includes("\u0000")),
    optionalFieldsValid(value, URL_FIELDS, isSafeExternalHttpUrl),
    optionalFieldsValid(value, BOOLEAN_FIELDS, field => typeof field === "boolean"),
    validMode(value.mode),
    validPullRequestNumber(value.pullRequestNumber),
    validPagesStatus(value.pagesStatus),
  ]
  return checks.every(Boolean)
}

function normalizeApplyResult(value: unknown): ApplyResult | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isUuid(value.taskId)) return null
  if (!validApplyResultFields(value)) return null

  const normalized: Record<string, unknown> = {}
  for (const field of RESULT_FIELDS) {
    if (value[field] !== undefined) normalized[field] = value[field]
  }
  return normalized as ApplyResult
}

function terminalResult(event: JobStreamEnvelope): ApplyResult | undefined {
  if (event.kind !== "job.terminal") return undefined
  if (event.payload.status !== "completed") {
    const code = boundedText(event.payload.errorCode, "", 96)
    throw new Error(`发布作业失败${code ? `：${code}` : ""}`)
  }
  const result = normalizeApplyResult(event.payload.result)
  if (!result) throw new Error("发布作业执行回执无效")
  return result
}

async function enqueueConfirmedOperation(
  requestBody: Record<string, unknown>,
  taskId: string,
  signal: AbortSignal,
  fetcher: Fetcher,
  confirmOperation: (message: string) => boolean,
): Promise<AcceptedJob> {
  let result = await postApply(requestBody, signal, fetcher)
  const challenge = confirmationChallenge(result)
  if (challenge) {
    const accepted = confirmOperation(challenge.prompt)
    await submitConfirmation(challenge, taskId, accepted, fetcher)
    result = await postApply({
      ...requestBody,
      confirmationId: challenge.id,
      confirmationToken: challenge.token,
    }, signal, fetcher)
  }
  if (!result.response.ok) {
    throw new Error(isRecord(result.data)
      ? boundedText(result.data.error, "发布作业入队失败")
      : "发布作业入队失败")
  }
  return acceptedJob(result.data)
}

export async function executeConfirmedCodeOperation(
  requestBody: Record<string, unknown>,
  taskId: string,
  dependencies: CodeApplyOperationDependencies = {},
): Promise<ApplyResult> {
  const controller = new AbortController()
  const fetcher = dependencies.fetcher ?? ((input, init) => globalThis.fetch(input, init))
  const confirmOperation = dependencies.confirm ?? (message => globalThis.confirm(message))
  const streamEvents = dependencies.streamEvents ?? streamJobEvents
  const accepted = await enqueueConfirmedOperation(
    requestBody, taskId, controller.signal, fetcher, confirmOperation,
  )
  for await (const event of streamEvents(accepted, controller.signal, 50 * 60_000)) {
    const result = terminalResult(event)
    if (result) return result
  }
  throw new Error("发布作业在终态前结束")
}
