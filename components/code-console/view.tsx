"use client"

import type { RefObject } from "react"
import { CircleAlert, Check, CornerDownLeft, GitBranch, Loader2, Square, X } from "lucide-react"
import { AnimatePresence } from "motion/react"

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
  TasksOverlay,
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
  onDismissApplyError: () => void
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

function LoadingConsole({ onExit }: Pick<CodeConsoleViewProps, "onExit">) {
  return (
    <Shell onExit={onExit}>
      <div role="status" aria-label="正在载入 Code" className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      </div>
    </Shell>
  )
}

function DisconnectedConsole({ onExit }: Pick<CodeConsoleViewProps, "onExit">) {
  return (
    <Shell onExit={onExit}>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <GitBranch className="size-8" style={{ color: ACCENT }} aria-hidden="true" />
        <h1 className="text-sm font-medium text-foreground" style={{ fontFamily: MONO }}>尚未连接 GitHub</h1>
        <button type="button" onClick={() => { window.location.href = "/api/auth/github" }}
          className="fluid-press min-h-11 rounded-lg px-5 text-sm font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          style={{ background: ACCENT, fontFamily: MONO }}>连接 GitHub</button>
      </main>
    </Shell>
  )
}

function ApplyErrorNotice({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="border-t border-destructive/30 bg-destructive/5 px-4 md:px-8">
      <div role="alert" className="mx-auto flex min-h-11 max-w-3xl items-center gap-2 py-1 text-[11px] leading-relaxed text-destructive">
        <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{message}</span>
        <button type="button" onClick={onDismiss} aria-label="关闭错误提示"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]">
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function ConversationPane(props: Pick<CodeConsoleViewProps,
  "scrollRef" | "messages" | "login" | "streaming" | "applying">) {
  return (
    <div ref={props.scrollRef} className="fluid-scroll flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 md:px-8" style={{ fontFamily: MONO }}>
      <div className="mx-auto max-w-3xl min-w-0 space-y-4">
        {props.messages.length === 0 && <p className="text-[11px] text-muted-foreground">当前会话尚无消息</p>}
        {props.messages.map(message => <MessageView key={message.id} message={message} login={props.login} />)}
        {(props.streaming || props.applying) && (
          <div role="status" className="flex items-center gap-2 text-[12px] text-muted-foreground" aria-live="polite">
            <WorkingDots className="shrink-0" style={{ color: ACCENT }} />
            <ThinkingTimer />
          </div>
        )}
      </div>
    </div>
  )
}

function WorkspacePublishBar(props: Pick<CodeConsoleViewProps,
  "currentTaskId" | "repo" | "workspaceDirty" | "publishPending" | "applying" | "onPublishWorkspacePR">) {
  if (!props.currentTaskId || !props.repo || (!props.workspaceDirty && !props.publishPending)) return null
  return (
    <div className="border-t border-border bg-secondary/40 px-4 py-2 md:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1 text-[11px] text-foreground" style={{ fontFamily: MONO }}>改动完成，等待确认发布</span>
        <button type="button" onClick={props.onPublishWorkspacePR} disabled={props.applying}
          className="fluid-press inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-[11px] font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: ACCENT }}>
          <GitBranch className="size-3.5" aria-hidden="true" />{props.applying ? "发布中…" : "确认发布"}
        </button>
      </div>
    </div>
  )
}

function PendingPlanBar(props: Pick<CodeConsoleViewProps,
  "pendingPlan" | "currentTaskId" | "workspaceDirty" | "auto" | "applying" | "onAbandonPlan" | "onApplyPlan">) {
  if (!props.pendingPlan.length || props.currentTaskId || props.workspaceDirty || props.auto) return null
  return (
    <div className="border-t border-border bg-secondary/40 px-4 py-2 md:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-center">
        <span className="min-w-0 flex-1 text-[11px] text-foreground" style={{ fontFamily: MONO }}>{planSummary(props.pendingPlan)}</span>
        <div className="flex gap-2">
          <button type="button" onClick={props.onAbandonPlan} disabled={props.applying}
            className="fluid-press inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-[11px] text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)] disabled:opacity-50 sm:flex-none">
            <X className="size-3.5" aria-hidden="true" />放弃
          </button>
          <button type="button" onClick={props.onApplyPlan} disabled={props.applying}
            className="fluid-press inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg px-4 text-[11px] font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)] disabled:opacity-50 sm:flex-none"
            style={{ background: ACCENT }}>
            <Check className="size-3.5" aria-hidden="true" />{props.applying ? "执行中…" : "确认并执行"}
          </button>
        </div>
      </div>
    </div>
  )
}

function CommandHints({ input, onCommand }: Pick<CodeConsoleViewProps, "input" | "onCommand">) {
  const show = input.startsWith("/") && !input.includes(" ")
  const matched = show ? COMMANDS.filter(command => command.cmd.startsWith(input.trim())) : []
  if (!matched.length) return null
  return (
    <div className="border-t border-border px-4 md:px-8">
      <div className="mx-auto max-w-3xl py-1.5" role="menu" aria-label="Code 命令">
        {matched.map(command => (
          <button type="button" role="menuitem" key={command.cmd} onClick={() => onCommand(command.cmd)}
            className="fluid-press flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]">
            <span className="text-[11px] font-medium" style={{ color: ACCENT, fontFamily: MONO }}>{command.cmd}</span>
            <span className="min-w-0 truncate text-[10px] text-muted-foreground">{command.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function CodeComposer(props: Pick<CodeConsoleViewProps,
  "input" | "repo" | "streaming" | "onInputChange" | "onSubmit" | "onStopAgent">) {
  const canSend = !props.streaming && !!props.input.trim()
  return (
    <div className="border-y border-border px-4 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 md:px-8">
      <div className="mx-auto flex min-h-14 max-w-3xl items-end gap-2">
        <span className="mb-3 shrink-0 select-none" aria-hidden="true" style={{ color: ACCENT, fontFamily: MONO }}>›</span>
        <label htmlFor="code-task-input" className="sr-only">任务目标</label>
        <textarea id="code-task-input" rows={1} value={props.input}
          onChange={event => { props.onInputChange(event.target.value); const element = event.target; element.style.height = "auto"; element.style.height = Math.min(element.scrollHeight, 160) + "px" }}
          onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!props.streaming) props.onSubmit() } }}
          placeholder={props.repo ? "输入仓库任务目标" : "输入新项目目标"}
          className="min-h-11 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
          style={{ fontFamily: MONO }} />
        {props.streaming ? (
          <button type="button" onClick={props.onStopAgent} aria-label="停止 Agent" title="停止"
            className="fluid-press fluid-icon-press mb-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary text-foreground hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]">
            <Square className="size-3.5 fill-current" aria-hidden="true" />
          </button>
        ) : (
          <button type="button" onClick={props.onSubmit} disabled={!canSend} aria-label="发送" title="发送"
            className={cn("fluid-press fluid-icon-press mb-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg border text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]", canSend ? "border-transparent text-white" : "border-border text-muted-foreground/40")}
            style={canSend ? { background: ACCENT } : undefined}>
            <CornerDownLeft className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  )
}

function ConsoleOverlays(props: Pick<CodeConsoleViewProps,
  "overlay" | "tier" | "repo" | "userId" | "messages" | "onChangeTier" | "onCloseOverlay" | "onLoadSession">) {
  return <AnimatePresence initial={false}>
    {props.overlay === "model" && <ModelOverlay key="model" tier={props.tier} onPick={props.onChangeTier} onClose={props.onCloseOverlay} />}
    {props.overlay === "memory" && props.repo && <MemoryOverlay key="memory" repo={props.repo} userId={props.userId} onClose={props.onCloseOverlay} />}
    {props.overlay === "memory" && !props.repo && <SimpleOverlay key="memory-empty" title="记忆" text="新项目尚未建立仓库。" onClose={props.onCloseOverlay} />}
    {props.overlay === "context" && <ContextOverlay key="context" messages={props.messages} onClose={props.onCloseOverlay} />}
    {props.overlay === "resume" && props.repo && <ResumeOverlay key="resume" repo={props.repo} onPick={props.onLoadSession} onClose={props.onCloseOverlay} />}
    {props.overlay === "resume" && !props.repo && <SimpleOverlay key="resume-empty" title="历史排查" text="新项目尚无历史会话。" onClose={props.onCloseOverlay} />}
    {props.overlay === "tasks" && <TasksOverlay key="tasks" onClose={props.onCloseOverlay} />}
  </AnimatePresence>
}

function ConnectedPicker(props: CodeConsoleViewProps) {
  return (
    <Shell onExit={props.onExit} login={props.login} onGhMenu={props.onOpenGhMenu} ghMenu={props.ghMenu} onCloseGh={props.onCloseGhMenu} onDisconnect={props.onDisconnect}>
      {props.applyError && <ApplyErrorNotice message={props.applyError} onDismiss={props.onDismissApplyError} />}
      <RepoPicker repos={props.repos} hidden={props.hiddenRepos} onLoad={props.onLoadRepos} onPick={props.onEnterRepo} onHide={props.onHideRepo} onReset={props.onResetHiddenRepos} />
    </Shell>
  )
}

function ActiveConsole(props: CodeConsoleViewProps) {
  return (
    <Shell onExit={props.onLeaveRepo} login={props.login} repo={props.repo} onSwitchRepo={props.onLeaveRepo}
      onGhMenu={props.onOpenGhMenu} ghMenu={props.ghMenu} onCloseGh={props.onCloseGhMenu} onDisconnect={props.onDisconnect}
      auto={props.repo ? undefined : props.auto} onToggleAuto={props.repo ? undefined : props.onToggleAuto}>
      <ConversationPane {...props} />
      {props.applyError && <ApplyErrorNotice message={props.applyError} onDismiss={props.onDismissApplyError} />}
      <WorkspacePublishBar {...props} />
      <PendingPlanBar {...props} />
      <CommandHints input={props.input} onCommand={props.onCommand} />
      <CodeComposer {...props} />
      <ConsoleOverlays {...props} />
    </Shell>
  )
}

export function CodeConsoleView(props: CodeConsoleViewProps) {
  if (props.connected === null) return <LoadingConsole onExit={props.onExit} />
  if (!props.connected) return <DisconnectedConsole onExit={props.onExit} />
  if (!props.entered) return <ConnectedPicker {...props} />
  return <ActiveConsole {...props} />
}
