import { NextRequest } from 'next/server'
import { enforceLimits, resolveAuth } from '@/lib/api/guard'
import { readJson, RequestError, requestErrorResponse } from '@/lib/api/request'
import { resolveChatModelSelection, ChatModelSelectionError } from '@/lib/chat/model-selection'
import { generateTitleText, validateTitleGenerationRequest } from '@/lib/chat/title-generation'
import { addQuotaUsage } from '@/lib/quota'
import { log } from '@/lib/logger'

export async function POST(request: NextRequest) {
  try {
    const body = validateTitleGenerationRequest(await readJson(request, { maxBytes: 16 * 1024 }))
    const auth = await resolveAuth()
    const gate = await enforceLimits(auth, request, { quota: body.endpointId === undefined })
    if (gate.response) return gate.response
    if (!auth.supabase || !auth.userId) {
      return Response.json({ error: '请先登录' }, { status: 401 })
    }
    const { data: conversation, error } = await auth.supabase
      .from('conversations')
      .select('id')
      .eq('id', body.conversationId)
      .eq('user_id', auth.userId)
      .maybeSingle()
    if (error) return Response.json({ error: '暂时无法验证对话归属' }, { status: 503 })
    if (!conversation) return Response.json({ error: '对话不存在' }, { status: 404 })

    const selection = await resolveChatModelSelection({
      tier: '绝句',
      deepResearch: false,
      endpointId: body.endpointId,
      supabase: auth.supabase,
      userId: auth.userId,
    })
    const result = await generateTitleText({ request: body, selection, signal: request.signal })
    if (!selection.customEndpoint) {
      await addQuotaUsage(
        auth.supabase,
        auth.userId,
        result.totalTokens,
        selection.model,
        false,
        gate.usingBalance,
      )
    }
    return Response.json({ title: result.title })
  } catch (error) {
    if (error instanceof ChatModelSelectionError) return error.toResponse()
    if (error instanceof RequestError) return requestErrorResponse(error)
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    log.error('title', 'Title generation failed', {
      name: error instanceof Error ? error.name : 'unknown',
    })
    return Response.json(
      { error: timeout ? '标题生成超时，请稍后重试' : '标题生成服务暂时不可用' },
      { status: timeout ? 504 : 502 },
    )
  }
}
