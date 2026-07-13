import type { NextRequest } from 'next/server'
import { saveWorkspaceCheckpoint } from '@/lib/agent/checkpoint'
import { codeContinuationPrompt, codeTurnContentPolicy } from '@/lib/agent/continuation'
import { isolatedShellConfigured } from '@/lib/agent/isolated-shell'
import { createRecorder } from '@/lib/agent/recorder'
import { isInternalRecoveryToken } from '@/lib/agent/recovery-token'
import { saveAgentRunState } from '@/lib/agent/run-state'
import { localWorkspaceExecutionAllowed } from '@/lib/agent/shell'
import { getChangedFiles } from '@/lib/agent/workspace'
import { buildCodeTools, createCodeToolExecutor } from '@/lib/code-tools'
import { runAgentLoop, type ExecuteTool } from '@/lib/llm/agent-loop'
import { chatCompletionsUrl, toOpenAI } from '@/lib/llm/openai'
import { done, networkError, send } from '@/lib/llm/stream'
import { log } from '@/lib/logger'
import { addQuotaUsage } from '@/lib/quota'
import type { CodeChatRequest } from './request'
import { createCodeEventCollector, createCodeRunProgress, finalCodeTaskStatus } from './runtime'
import { buildCodeSystem } from './system-prompt'
import type { PreparedCodeRun } from './task-context'

type CodeStreamOptions = {
  req: NextRequest
  body: CodeChatRequest
  run: PreparedCodeRun
  apiKey: string
  baseUrl: string
  tavilyApiKey: string
  model: string
  thinking: boolean
  usingBalance: boolean
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
}

export async function createCodeAgentStream(options: CodeStreamOptions): Promise<Response> {
  const { req, body, run, apiKey, baseUrl, tavilyApiKey, model, thinking, usingBalance } = options
  const { repo, responseId, sessionId } = body
  const {
    supabase, userId, effectiveTaskId, token, login, defaultBranch, repoIsPrivate,
    hasWorkspace, workspaceReady, memories, lease,
  } = run
  const recorder = createRecorder({ supabase, userId, taskId: effectiveTaskId })
  if (effectiveTaskId) await recorder.setTaskStatus('running')

  const canExecute = isolatedShellConfigured() || localWorkspaceExecutionAllowed()
  const system = buildCodeSystem(repo, login, memories, hasWorkspace, canExecute)
  const tools = buildCodeTools({
    isWorkspace: Boolean(repo),
    executePermission: isolatedShellConfigured()
      ? '在当前任务独享的 Linux 沙箱中执行完整终端命令'
      : '在 workspace 中执行受控命令',
    canExecute,
  })
  const url = chatCompletionsUrl(baseUrl)
  let clientConnected = true

  const stream = new ReadableStream({
    async start(controller) {
      const safeSend = (data: object) => {
        if (!clientConnected) return
        try { send(controller, data) } catch { clientConnected = false }
      }
      const streamHeartbeat = setInterval(() => safeSend({ heartbeat: true }), 8_000)
      const events = createCodeEventCollector({
        send: safeSend,
        recordStep: (kind, label) => { void recorder.step(kind, label) },
      })
      let totalTokensUsed = 0
      const canResume = isInternalRecoveryToken(req.headers.get('x-agent-recovery'))
      const messages: any[] = [
        { role: 'system', content: system },
        ...(canResume && body.resumeMessages ? body.resumeMessages : toOpenAI(body.messages)),
      ]
      if (effectiveTaskId) safeSend({ taskId: effectiveTaskId })

      const wsTaskId = effectiveTaskId ?? ''
      const wsUserId = userId ?? ''
      let cancelled = false
      const workspaceHasChanges = () => {
        if (!workspaceReady) return false
        const changed = getChangedFiles(wsTaskId, wsUserId)
        return changed.ok && changed.data.files.length > 0
      }
      const progress = createCodeRunProgress(workspaceHasChanges)
      const executeToolImpl = createCodeToolExecutor({
        repo,
        login,
        token,
        defaultBranch,
        repoIsPrivate,
        supabase,
        userId,
        wsReady: workspaceReady,
        wsTaskId,
        wsUserId,
        tavilyApiKey,
        emit: events.emit,
        signal: req.signal,
        canExecute,
        state: progress.toolState,
      })

      const checkpointTools = new Set(['write_files', 'edit_file', 'delete_files', 'apply_patch', 'execute', 'verify'])
      const executeTool: ExecuteTool = async (name, input) => {
        if (cancelled) throw new Error('任务已取消')
        const execute = () => executeToolImpl(name, input)
        const result = name === 'execute' ? await execute() : await recorder.recordToolCall(name, input, execute)
        const shouldCheckpoint = workspaceReady
          && checkpointTools.has(name)
          && !(name === 'apply_patch' && input?.dryRun === true)
        if (shouldCheckpoint && supabase) {
          const checkpoint = await saveWorkspaceCheckpoint(supabase, wsUserId, wsTaskId)
          if (!checkpoint.ok) await recorder.step('error', '后台检查点保存失败', checkpoint.error)
        }
        return result
      }

      const taskHeartbeat = setInterval(() => {
        if (!effectiveTaskId || !supabase || !userId) return
        if (lease.isClaimed()) {
          void supabase.rpc('renew_agent_run', {
            input_task_id: effectiveTaskId,
            input_run_id: lease.runId,
            lease_seconds: 120,
          }).then(({ data }) => { if (data !== true) cancelled = true })
          return
        }
        void supabase.from('agent_tasks').select('status').eq('id', effectiveTaskId).eq('user_id', userId).single()
          .then(async ({ data }) => {
            if (data?.status === 'cancelled') {
              cancelled = true
              return
            }
            await supabase.from('agent_tasks').update({ updated_at: new Date().toISOString() })
              .eq('id', effectiveTaskId).eq('user_id', userId).eq('status', 'running')
          })
      }, 15_000)

      let loopFailed = false
      try {
        await runAgentLoop({
          url,
          apiKey,
          model,
          adapter: 'deepseek-openai',
          thinking,
          messages,
          tools,
          emit: events.emit,
          executeTool,
          maxRounds: 80,
          turnOptions: {
            deferTextUntilTurnEnd: true,
            contentPolicy: codeTurnContentPolicy,
            signal: req.signal,
            timeoutMs: 120_000,
          },
          leakedRetry: true,
          autoContinue: { maxContinuations: 6 },
          idleContinuation: {
            maxContinuations: 20,
            prompt: ({ idleCount }) => {
              const state = progress.snapshot(workspaceReady)
              const prompt = codeContinuationPrompt(state)
              log.info('codeChat', 'Idle decision', { idleCount, ...state, continuing: Boolean(prompt) })
              return prompt
            },
          },
          onTurn: ({ phase, round, turn }) => {
            log.info('codeChat', `Turn ${phase}`, {
              round,
              finishReason: turn.finishReason,
              leaked: turn.leaked,
              tools: turn.toolCalls.map(call => call.name),
              contentLen: turn.content.length,
              truncated: turn.truncated,
            })
          },
          onUsage: total => { totalTokensUsed = total },
          onCheckpoint: async latestMessages => {
            if (effectiveTaskId && supabase && userId) {
              await saveAgentRunState(supabase, userId, effectiveTaskId, { resumeMessages: latestMessages.slice(1) })
            }
          },
        })
      } catch (error) {
        loopFailed = true
        if (!cancelled) events.emit({ error: networkError(error) })
      } finally {
        const finalText = events.flushLeadText()
        clearInterval(streamHeartbeat)
        clearInterval(taskHeartbeat)
        const state = progress.snapshot(workspaceReady)

        if (effectiveTaskId) {
          if (supabase && userId) {
            const { data } = await supabase.from('agent_tasks').select('status')
              .eq('id', effectiveTaskId).eq('user_id', userId).single()
            cancelled = data?.status === 'cancelled'
          }
          if (!cancelled) await recorder.setTaskStatus(finalCodeTaskStatus(loopFailed, state))
          if (finalText.trim()) {
            await recorder.artifact('summary', {
              title: 'Code Agent 回复',
              content: finalText,
              meta: {
                responseId,
                sessionId,
                completed: state.completed,
                waitingForUser: state.waitingForUser,
                publishCalled: state.published,
              },
            })
          }
          if (supabase && userId && responseId && sessionId && finalText.trim()) {
            await supabase.from('code_messages').delete().eq('id', responseId).eq('user_id', userId)
            await supabase.from('code_messages').insert({
              id: responseId,
              session_id: sessionId,
              user_id: userId,
              role: 'assistant',
              content: finalText,
              meta: { taskId: effectiveTaskId },
            })
          }
        }
        if (userId && supabase) {
          await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        }
        await lease.release()
        if (clientConnected) {
          try { done(controller) } catch { clientConnected = false }
        }
      }
    },
    cancel() { clientConnected = false },
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
