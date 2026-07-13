"use client"

import type { RefObject } from "react"
import { Check, CornerDownLeft, GitBranch, Loader2, Square, X } from "lucide-react"

import { AgentTasksPanel } from "@/components/agent-tasks-panel"
import { WorkingDots } from "@/components/working-dots"
import { type Tier } from "@/lib/chat-data"
import { type CodeMessage, type CodeSession, type PlanAction } from "@/lib/code-data"
import { cn } from "@/lib/utils"
import {
  ACCENT,
  COMMANDS,
  ContextOverlay,
  MemoryOverlay,
  MessageView,
  ModelOverlay,
  MONO,
  RepoPicker,
  ResumeOverlay,
  Shell,
  SimpleOverlay,
  ThinkingTimer,
  planSummary,
  type Overlay,
  type RepoItem,
} from "./presentation"

export type CodeConsoleViewProps = {
  userId: string
  onExit: () => void
  connected: boolean | null
  login: string
  repos: RepoItem[] | null
  repo: string | null
  entered: boolean
  hiddenRepos: string[]
  onLoadRepos: () => void
  onEnterRepo: (repo: string | null) => void
  onHideRepo: (repo: string) => void
  onResetHiddenRepos: () => void
  ghMenu: boolean
  onOpenGhMenu: () => void
  onCloseGhMenu: () => void
  onDisconnect: () => void
  onLeaveRepo: () => void
  auto: boolean
  onToggleAuto: () => void
  scrollRef: RefObject<HTMLDivElement | null>
  messages: CodeMessage[]
  streaming: boolean
  applying: boolean
  currentTaskId: string | null
  workspaceDirty: boolean
  publishPending: boolean
  applyError: string | null
  onPublishWorkspacePR: () => void
  pendingPlan: PlanAction[]
  onAbandonPlan: () => void
  onApplyPlan: () => void
  input: string
  onInputChange: (value: string) => void
  onSubmit: () => void
  onStopAgent: () => void
  onCommand: (command: string) => void
  overlay: Overlay
  onCloseOverlay: () => void
  tier: Tier
  onChangeTier: (tier: Tier) => void
  onLoadSession: (session: CodeSession) => void
}

export function CodeConsoleView(props: CodeConsoleViewProps) {
  const showCommandHint = props.input.startsWith("/") && !props.input.includes(" ")
  const matchedCommands = COMMANDS.filter(command => command.cmd.startsWith(props.input.trim()))
  const canSend = !props.streaming && !!props.input.trim()

  if (props.connected === null) {
    return <Shell onExit={props.onExit}><div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div></Shell>
  }

  if (!props.connected) {
    return (
      <Shell onExit={props.onExit}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <GitBranch className="size-8" style={{ color: ACCENT }} />
          <p className="text-foreground" style={{ fontFamily: MONO }}>连接你自己的 GitHub，就能让它读写你的仓库</p>
          <button onClick={() => { window.location.href = "/api/auth/github" }}
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: ACCENT, fontFamily: MONO }}>连接 GitHub</button>
        </div>
      </Shell>
    )
  }

  if (!props.entered) {
    return (
      <Shell onExit={props.onExit} login={props.login} onGhMenu={props.onOpenGhMenu} ghMenu={props.ghMenu} onCloseGh={props.onCloseGhMenu} onDisconnect={props.onDisconnect}>
        <RepoPicker repos={props.repos} hidden={props.hiddenRepos} onLoad={props.onLoadRepos} onPick={props.onEnterRepo} onHide={props.onHideRepo} onReset={props.onResetHiddenRepos} />
      </Shell>
    )
  }

  return (
    <Shell onExit={props.onLeaveRepo} login={props.login} repo={props.repo} onSwitchRepo={props.onLeaveRepo}
      onGhMenu={props.onOpenGhMenu} ghMenu={props.ghMenu} onCloseGh={props.onCloseGhMenu} onDisconnect={props.onDisconnect}
      auto={props.repo ? undefined : props.auto} onToggleAuto={props.repo ? undefined : props.onToggleAuto}>
      <div ref={props.scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 md:px-8" style={{ fontFamily: MONO }}>
        <div className="mx-auto max-w-3xl min-w-0 space-y-4">
          {props.messages.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              {props.repo ? "描述问题或想做的改动，我会自己浏览仓库、定位、动手。" : "告诉我你想做什么（比如「做个番茄钟」），我会新建仓库、写代码、上线。"} 输入 / 看命令。
            </p>
          )}
          {props.messages.map(message => <MessageView key={message.id} message={message} login={props.login} />)}
          {(props.streaming || props.applying) && (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground" aria-live="polite">
              <WorkingDots className="shrink-0" style={{ color: ACCENT }} />
              <ThinkingTimer />
            </div>
          )}
        </div>
      </div>

      {props.currentTaskId && props.repo && (props.workspaceDirty || props.publishPending) && (
        <div className="border-t border-border bg-secondary/40 px-4 py-3 md:px-8">
          <div className="mx-auto max-w-3xl">
            {props.applyError && <p className="mb-2 text-[11px] leading-relaxed text-destructive">{props.applyError}</p>}
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-foreground" style={{ fontFamily: MONO }}>改动完成，等待确认发布</span>
              <div className="ml-auto flex gap-2">
                <button onClick={props.onPublishWorkspacePR} disabled={props.applying}
                  className="flex items-center gap-1 rounded-lg px-3.5 py-1.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  style={{ background: ACCENT }}>
                  <GitBranch className="size-3.5" />{props.applying ? "发布中…" : "确认发布"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {props.pendingPlan.length > 0 && !props.currentTaskId && !props.workspaceDirty && !props.auto && (
        <div className="border-t border-border bg-secondary/40 px-4 py-3 md:px-8">
          <div className="mx-auto max-w-3xl">
            {props.applyError && <p className="mb-2 text-[11px] leading-relaxed text-destructive">{props.applyError}</p>}
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-foreground" style={{ fontFamily: MONO }}>{planSummary(props.pendingPlan)}</span>
              <div className="ml-auto flex gap-2">
                <button onClick={props.onAbandonPlan} disabled={props.applying}
                  className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-secondary">
                  <X className="size-3.5" />放弃
                </button>
                <button onClick={props.onApplyPlan} disabled={props.applying}
                  className="flex items-center gap-1 rounded-lg px-3.5 py-1.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  style={{ background: ACCENT }}>
                  <Check className="size-3.5" />{props.applying ? "执行中…" : "确认并执行"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showCommandHint && matchedCommands.length > 0 && (
        <div className="border-t border-border px-4 md:px-8">
          <div className="mx-auto max-w-3xl py-1.5">
            {matchedCommands.map(command => (
              <button key={command.cmd} onClick={() => props.onCommand(command.cmd)}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-secondary/60">
                <span className="text-[11px] font-medium" style={{ color: ACCENT, fontFamily: MONO }}>{command.cmd}</span>
                <span className="text-[10px] text-muted-foreground">{command.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-y border-border px-4 py-1 md:px-8">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <span className="shrink-0 select-none" style={{ color: ACCENT, fontFamily: MONO }}>›</span>
          <textarea rows={1} value={props.input}
            onChange={event => { props.onInputChange(event.target.value); const element = event.target; element.style.height = "auto"; element.style.height = Math.min(element.scrollHeight, 160) + "px" }}
            onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!props.streaming) props.onSubmit() } }}
            placeholder={props.repo ? "描述目标，我会自主执行到完成……" : "想做什么？比如「做个番茄钟」……"}
            className="min-h-0 flex-1 resize-none bg-transparent py-0 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/60"
            style={{ fontFamily: MONO }} />
          {props.streaming ? (
            <button onClick={props.onStopAgent} aria-label="停止"
              className="flex h-7 items-center justify-center rounded-lg border border-border bg-secondary px-2.5 text-foreground transition-colors hover:bg-secondary/70">
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button onClick={props.onSubmit} disabled={!canSend} aria-label="发送" title="Enter 发送"
              className={cn("flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-medium transition-all", canSend ? "border-transparent text-white" : "border-border text-muted-foreground/40")}
              style={canSend ? { background: ACCENT } : undefined}>
              <CornerDownLeft className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {props.overlay === "model" && <ModelOverlay tier={props.tier} onPick={props.onChangeTier} onClose={props.onCloseOverlay} />}
      {props.overlay === "memory" && props.repo && <MemoryOverlay repo={props.repo} userId={props.userId} onClose={props.onCloseOverlay} />}
      {props.overlay === "memory" && !props.repo && <SimpleOverlay title="记忆" text="新项目还没有仓库，建好后再来记。" onClose={props.onCloseOverlay} />}
      {props.overlay === "context" && <ContextOverlay messages={props.messages} onClose={props.onCloseOverlay} />}
      {props.overlay === "resume" && props.repo && <ResumeOverlay repo={props.repo} onPick={props.onLoadSession} onClose={props.onCloseOverlay} />}
      {props.overlay === "resume" && !props.repo && <SimpleOverlay title="历史排查" text="新项目模式暂无历史。建好仓库后会自动记录。" onClose={props.onCloseOverlay} />}
      {props.overlay === "tasks" && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" onClick={props.onCloseOverlay}>
          <div className="absolute inset-0 bg-black/50" />
          <div onClick={event => event.stopPropagation()} className="relative w-full max-w-md h-[70vh] max-h-[600px] rounded-t-2xl border border-border bg-card sm:rounded-2xl overflow-hidden">
            <AgentTasksPanel onClose={props.onCloseOverlay} />
          </div>
        </div>
      )}
    </Shell>
  )
}

