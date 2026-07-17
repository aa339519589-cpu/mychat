import assert from "node:assert/strict"
import test from "node:test"
import {
  executeConfirmedCodeOperation,
  type CodeApplyOperationDependencies,
} from "../components/code-console/apply-operation"
import type { AcceptedJob, JobStreamEnvelope } from "../components/literary-chat/job-stream-client"

const TASK_ID = "72000000-0000-4000-8000-000000000001"
const JOB_ID = "72000000-0000-4000-8000-000000000002"
const CONFIRMATION_ID = "72000000-0000-4000-8000-000000000003"
const CONFIRMATION_TOKEN = "a".repeat(43)
const STREAM_URL = `/api/v1/jobs/${JOB_ID}/events?from_seq=0`

function acceptedResponse(streamUrl = STREAM_URL): Response {
  return Response.json({ jobId: JOB_ID, status: "queued", streamUrl }, { status: 202 })
}

function terminal(result: Record<string, unknown>): JobStreamEnvelope {
  return {
    jobId: JOB_ID,
    seq: 1,
    kind: "job.terminal",
    payload: { status: "completed", result },
  }
}

function streamer(events: JobStreamEnvelope[]) {
  return async function* stream(
    accepted: AcceptedJob,
    _signal: AbortSignal,
    deadlineMs?: number,
  ): AsyncGenerator<JobStreamEnvelope> {
    assert.deepEqual(accepted, { jobId: JOB_ID, status: "queued", streamUrl: STREAM_URL })
    assert.equal(deadlineMs, 50 * 60_000)
    yield* events
  }
}

test("confirmed code operation returns a normalized durable receipt", async () => {
  let postedBody: Record<string, unknown> | null = null
  const result = await executeConfirmedCodeOperation({ taskId: TASK_ID, actions: [] }, TASK_ID, {
    fetcher: async (url, init) => {
      assert.equal(url, "/api/code/apply")
      postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return acceptedResponse()
    },
    streamEvents: streamer([terminal({
      schemaVersion: 1,
      taskId: TASK_ID,
      mode: "direct_push",
      created: true,
      repo: "owner/project",
      ignoredServerField: "not persisted",
    })]),
  })

  assert.deepEqual(postedBody, { taskId: TASK_ID, actions: [] })
  assert.deepEqual(result, {
    mode: "direct_push",
    created: true,
    repo: "owner/project",
  })
})

test("confirmed code operation submits a one-time decision before retrying", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  let prompt = ""
  const dependencies: CodeApplyOperationDependencies = {
    fetcher: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      if (calls.length === 1) return Response.json({
        needsConfirmation: true,
        operation: "publish",
        confirmationId: CONFIRMATION_ID,
        confirmationToken: CONFIRMATION_TOKEN,
        risk: { title: "创建仓库", reason: "会写入 GitHub" },
      }, { status: 409 })
      if (calls.length === 2) return Response.json({ ok: true })
      return acceptedResponse()
    },
    confirm: message => { prompt = message; return true },
    streamEvents: streamer([terminal({
      schemaVersion: 1,
      taskId: TASK_ID,
      mode: "workspace_pr",
      pullRequestUrl: "https://github.com/owner/project/pull/1",
      pullRequestNumber: 1,
    })]),
  }

  const result = await executeConfirmedCodeOperation({ repo: "owner/project" }, TASK_ID, dependencies)

  assert.equal(prompt, "创建仓库\n\n会写入 GitHub")
  assert.equal(calls[1].url, `/api/agent/tasks/${TASK_ID}/confirm`)
  assert.deepEqual(calls[1].body, {
    action: "confirm",
    operation: "publish",
    confirmationId: CONFIRMATION_ID,
    confirmationToken: CONFIRMATION_TOKEN,
  })
  assert.equal(calls[2].body.confirmationId, CONFIRMATION_ID)
  assert.equal(calls[2].body.confirmationToken, CONFIRMATION_TOKEN)
  assert.equal(result.pullRequestNumber, 1)
})

test("rejecting a code operation records the rejection and never retries", async () => {
  let calls = 0
  await assert.rejects(() => executeConfirmedCodeOperation({}, TASK_ID, {
    fetcher: async () => {
      calls++
      if (calls === 1) return Response.json({
        needsConfirmation: true,
        operation: "publish",
        confirmationId: CONFIRMATION_ID,
        confirmationToken: CONFIRMATION_TOKEN,
      }, { status: 409 })
      return Response.json({ ok: true })
    },
    confirm: () => false,
    streamEvents: streamer([]),
  }), /已取消高风险发布/)
  assert.equal(calls, 2)
})

test("code operation rejects cross-origin streams and malformed receipts", async () => {
  await assert.rejects(() => executeConfirmedCodeOperation({}, TASK_ID, {
    fetcher: async () => acceptedResponse("https://attacker.example/events"),
    streamEvents: streamer([]),
  }), /事件流地址无效/)

  await assert.rejects(() => executeConfirmedCodeOperation({}, TASK_ID, {
    fetcher: async () => acceptedResponse(),
    streamEvents: streamer([terminal({
      schemaVersion: 1,
      taskId: TASK_ID,
      mode: "direct_push",
      repoUrl: "javascript:alert(1)",
    })]),
  }), /执行回执无效/)
})
