import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceQuotaLimit, enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, RequestError } from '@/lib/api/request'
import { expensiveWriteMaintenanceResponse } from '@/lib/api/maintenance'
import { buildModelContext } from '@/lib/llm/context'
import { runAgentLoop } from '@/lib/llm/agent-loop'
import type { ChatEvent } from '@/lib/llm/events'
import { chatCompletionsUrl } from '@/lib/llm/openai'
import type { ReasoningEffort } from '@/lib/llm/provider-adapters'
import { buildSystem } from '@/lib/llm/system'
import type { ChatRequestBody } from '@/lib/llm/chat-request'
import { validateChatRequest } from '@/lib/llm/chat-request'
import { releaseTrialCall, reserveTrialCall } from '@/lib/chat/model-access'
import { ChatModelSelectionError, resolveChatModelSelection } from '@/lib/chat/model-selection'
import { latestBeijingDateFromMessages } from '@/lib/chat/request-context'
import { addQuotaUsage } from '@/lib/quota'
import { activeTools, execTool, toOpenAITools } from '@/lib/tools'

const MAX_ROUNDS = 16
const MAX_OUTPUT_TOKENS = 40_000
const TRIAL_MAX_OUTPUT_TOKENS = 10_000
const encoder = new TextEncoder()

type PrivateChatRequest = ChatRequestBody & {
  conversationId: string
  modelId: string
}

function validatePrivateChatRequest(value: unknown): PrivateChatRequest {
  const body = validateChatRequest(value)
  if (!body.conversationId || !body.modelId) {
    throw new RequestError(400, 'conversationId 和 modelId 必须提供')
  }
  if (body.endpointId) throw new RequestError(400, '隐私聊天仅支持 MyChat 平台模型')
  if (body.historyRetrieval !== false) throw new RequestError(400, '隐私聊天不能读取历史记忆')
  if (body.memories || body.project || body.turn || body.attachments?.length) {
    throw new RequestError(400, '隐私聊天请求包含不允许持久化的上下文')
  }
  if (body.messages.at(-1)?.role !== 'user') {
    throw new RequestError(400, '隐私聊天最后一条消息必须来自用户')
  }
  return body as PrivateChatRequest
}

function modelSelectionResponse(request: Request, error: ChatModelSelectionError): Response {
  return apiErrorResponseV1(request, {
    status: error.status,
    code: error.status === 404
      ? 'NOT_FOUND'
      : error.status === 401
        ? 'AUTH_REQUIRED'
        : error.status === 403
          ? 'FORBIDDEN'
          : 'CONFLICT',
    message: error.message,
    retryable: error.status >= 500,
  })
}

function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
}

export async function POST(request: NextRequest) {
  const maintenance = expensiveWriteMaintenanceResponse(request)
  if (maintenance) return maintenance

  const auth = await resolveAuth(request)
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  if (!auth.supabase || !auth.userId) return apiErrorResponseV1(request, {
    status: auth.authUnavailable ? 503 : 401,
    code: auth.authUnavailable ? 'AUTH_DEPENDENCY_UNAVAILABLE' : 'AUTH_REQUIRED',
    message: auth.authUnavailable ? '认证服务暂时不可用' : '请先登录',
    retryable: auth.authUnavailable === true,
    ...(auth.authUnavailable ? { headers: { 'Retry-After': '5' } } : {}),
  })
  const client = auth.supabase
  const userId = auth.userId

  let body: PrivateChatRequest
  try {
    body = validatePrivateChatRequest(await readJson(request, { maxBytes: 8 * 1024 * 1024 }))
  } catch (error) {
    return apiErrorResponseV1(request, {
      status: error instanceof RequestError ? error.status : 400,
      code: error instanceof RequestError && error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
      message: error instanceof Error ? error.message : '请求体格式错误',
      retryable: false,
    })
  }

  let selection
  try {
    selection = await resolveChatModelSelection({
      tier: body.tier ?? '绝句',
      modelId: body.modelId,
      reasoningEffort: body.reasoningEffort,
      supabase: client,
      userId,
      allowPremium: true,
    })
  } catch (error) {
    if (error instanceof ChatModelSelectionError) return modelSelectionResponse(request, error)
    return apiErrorResponseV1(request, {
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: '模型策略暂时不可用',
      retryable: true,
      headers: { 'Retry-After': '5' },
    })
  }
  if (selection.outputKind !== 'chat' || selection.customEndpoint) {
    return apiErrorResponseV1(request, {
      status: 400,
      code: 'INVALID_REQUEST',
      message: '隐私聊天仅支持 MyChat 平台对话模型',
      retryable: false,
    })
  }

  const needsQuota = selection.accessClass === 'quota' || selection.accessClass === 'legacy'
  let usingBalance = false
  if (needsQuota) {
    const quota = await enforceQuotaLimit(auth, { quota: true })
    if (quota.response) return quota.response
    usingBalance = quota.usingBalance
  }

  let trialReserved = false
  if (selection.accessClass === 'trial' && auth.isOwner !== true) {
    try {
      const trial = await reserveTrialCall(
        client,
        userId,
        body.conversationId,
        selection.model,
      )
      if (!trial.allowed) return apiErrorResponseV1(request, {
        status: 403,
        code: 'QUOTA_EXCEEDED',
        message: '其他模型共享的 3 次额度已用完，当前剩余 0 次。',
        retryable: false,
        details: { trialLimit: 3, trialRemaining: 0 },
      })
      trialReserved = !trial.duplicate
    } catch (error) {
      return apiErrorResponseV1(request, {
        status: 503,
        code: 'DEPENDENCY_UNAVAILABLE',
        message: error instanceof Error ? error.message : '其他模型额度服务暂时不可用',
        retryable: true,
      })
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        let sequence = 0
        let content = ''
        let thinking = ''
        let completed = false
        const send = (kind: string, payload: Record<string, unknown>) => {
          sequence += 1
          const envelope = {
            jobId: body.conversationId,
            seq: sequence,
            kind,
            payload,
          }
          controller.enqueue(encoder.encode(
            `id: ${sequence}\nevent: ${kind}\ndata: ${JSON.stringify(envelope)}\n\n`,
          ))
        }
        const emit = (event: ChatEvent) => {
          if ('text' in event) {
            content += event.text
            send('text.delta', { text: event.text })
          } else if ('thinking' in event) {
            thinking += event.thinking
            send('thinking.delta', { thinking: event.thinking })
          } else if ('search' in event) {
            send('tool.search', { search: event.search })
          }
        }

        try {
          const searchMode = body.searchMode === 'web' ? 'web' : 'off'
          const tools = activeTools({
            loggedIn: true,
            searchMode,
            memoryEnabled: false,
            projectId: null,
          })
          const latestBeijingDate = latestBeijingDateFromMessages(body.messages)
          const system = `${buildSystem(undefined, {
            searchMode,
            latestBeijingDate,
            memoryEnabled: false,
            modelSource: 'platform',
            tierLabel: selection.platformTierLabel,
            renderRules: body.renderEnabled === true,
          })}\n【隐私会话】\n这是一次性隐私对话。不得读取、创建、更新或删除长期记忆，也不得声称已经保存本次对话。`
          const modelMessages = [
            { role: 'system' as const, content: system },
            ...buildModelContext(body.messages, selection.capability),
          ]
          const result = await runAgentLoop({
            url: chatCompletionsUrl(selection.capability.provider.baseUrl),
            apiKey: selection.apiKey,
            model: selection.model,
            adapter: selection.capability.provider.adapter,
            thinking: selection.thinking,
            reasoningEffort: selection.reasoningEffort as ReasoningEffort | null,
            messages: modelMessages,
            tools: toOpenAITools(tools),
            emit,
            executeTool: async (name, input) => {
              const outcome = await execTool(tools, name, input, {
                supabase: client,
                userId,
                projectId: null,
                searchMode,
                latestBeijingDate,
                signal: request.signal,
              })
              if (outcome.event) emit(outcome.event as ChatEvent)
              return outcome.result
            },
            maxRounds: MAX_ROUNDS,
            leakedRetry: true,
            autoContinue: selection.accessClass === 'trial'
              ? undefined
              : { maxContinuations: 4 },
            turnOptions: {
              signal: request.signal,
              timeoutMs: 120_000,
              authType: selection.authType,
              maxOutputTokens: selection.accessClass === 'trial'
                ? TRIAL_MAX_OUTPUT_TOKENS
                : MAX_OUTPUT_TOKENS,
              idempotencyNamespace: `private:${body.conversationId}`,
            },
          })
          if (needsQuota) {
            await addQuotaUsage(
              client,
              userId,
              result.totalTokens,
              selection.model,
              selection.thinking,
              usingBalance,
            )
          }
          send('job.terminal', {
            status: 'completed',
            result: { content, thinking, media: [], tokenUsage: result.tokenUsage },
          })
          completed = true
        } catch (error) {
          if (trialReserved) {
            await releaseTrialCall(client, userId, body.conversationId).catch(() => undefined)
            trialReserved = false
          }
          if (!request.signal.aborted) {
            send('job.terminal', {
              status: 'failed',
              result: { content, thinking, media: [] },
              errorCode: error instanceof Error ? error.name : 'PRIVATE_CHAT_FAILED',
            })
          }
        } finally {
          if (!completed && request.signal.aborted && trialReserved) {
            await releaseTrialCall(client, userId, body.conversationId).catch(() => undefined)
            trialReserved = false
          }
          controller.close()
        }
      })()
    },
  })

  return new Response(stream, { status: 200, headers: sseHeaders() })
}
