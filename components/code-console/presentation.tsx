"use client"

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ExternalLink,
  GitBranch,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react"

import { AgentTasksPanel } from "@/components/agent-tasks-panel"
import { CODE_TIERS, type Tier } from "@/lib/chat-data"
import {
  deleteCodeMemory,
  fetchCodeMemories,
  fetchCodeSessions,
  insertCodeMemory,
  type CodeMemory,
  type CodeMessage,
  type CodeSession,
} from "@/lib/code-data"
import { cn } from "@/lib/utils"
import { PANEL_SPRING, POPOVER_SPRING, transitionFor } from "@/components/motion/fluid"
import { ACCENT, CONTROL_FOCUS, MONO, type RepoItem } from "./shared"

export { MessageView, ThinkingTimer } from "./message-view"
export { computeDiff } from "./diff"
export { ACCENT, COMMANDS, MONO, planSummary, type Overlay, type RepoItem } from "./shared"

const HEADER_CONTROL = "fluid-press inline-flex min-h-11 items-center justify-center rounded-md hover:bg-secondary"
const ICON_CONTROL = "fluid-press fluid-icon-press inline-flex size-11 shrink-0 items-center justify-center rounded-md"

export function Shell({ children, onExit, repo, login, onSwitchRepo, onGhMenu, ghMenu, onCloseGh, onDisconnect, auto, onToggleAuto }: {
  children: ReactNode
  onExit: () => void
  repo?: string | null
  login?: string
  onSwitchRepo?: () => void
  onGhMenu?: () => void
  ghMenu?: boolean
  onCloseGh?: () => void
  onDisconnect?: () => void
  auto?: boolean
  onToggleAuto?: () => void
}) {
  const reducedMotion = useReducedMotion()
  return (
    <div className="paper-grain fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background">
      <header className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5 sm:gap-2 sm:px-4 md:px-8">
        <button type="button" onClick={onExit} aria-label="返回"
          className={cn(HEADER_CONTROL, CONTROL_FOCUS, "gap-1 px-2 text-[11px] text-muted-foreground")} style={{ fontFamily: MONO }}>
          <ChevronLeft className="size-4" aria-hidden="true" /><span className="hidden sm:inline">返回</span>
        </button>
        <span className="shrink-0 text-[11px]" style={{ color: ACCENT, fontFamily: MONO }}>CODE</span>

        <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
          {onToggleAuto && (
            <button type="button" role="switch" aria-checked={auto === true} onClick={onToggleAuto} title="执行模式"
              className={cn(HEADER_CONTROL, CONTROL_FOCUS, "border border-border px-2 text-[10px]")}
              style={{ fontFamily: MONO, color: auto ? ACCENT : undefined, borderColor: auto ? ACCENT : undefined }}>
              {auto ? "自动" : "确认"}
            </button>
          )}
          {repo !== undefined && repo && (
            <button type="button" onClick={onSwitchRepo} title={repo}
              className={cn(HEADER_CONTROL, CONTROL_FOCUS, "min-w-0 max-w-[34vw] gap-1.5 px-2 text-[11px] text-foreground/80 sm:max-w-[48vw]")} style={{ fontFamily: MONO }}>
              <GitBranch className="size-3.5 shrink-0" style={{ color: ACCENT }} aria-hidden="true" /><span className="truncate">{repo}</span>
            </button>
          )}
          {repo !== undefined && !repo && login !== undefined && (
            <span className="hidden min-h-11 items-center rounded-md px-2 text-[11px] text-muted-foreground min-[380px]:inline-flex" style={{ fontFamily: MONO }}>新项目</span>
          )}
          {login !== undefined && (
            <div className="relative">
              <button type="button" onClick={onGhMenu} aria-expanded={ghMenu === true} aria-controls="code-github-menu"
                className={cn(HEADER_CONTROL, CONTROL_FOCUS, "min-w-0 max-w-[24vw] gap-1 px-2 text-[11px] text-muted-foreground sm:max-w-none")} style={{ fontFamily: MONO }}>
                <span className="truncate">{login ? `@${login}` : "GitHub"}</span><ChevronDown className="size-3 shrink-0" aria-hidden="true" />
              </button>
              <AnimatePresence initial={false}>
              {ghMenu && (
                <motion.div key="github-menu-layer" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transitionFor(reducedMotion)}>
                  <div className="fixed inset-0 z-10" aria-hidden="true" onMouseDown={onCloseGh} />
                  <motion.div
                    id="code-github-menu"
                    role="menu"
                    initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.97 }}
                    transition={transitionFor(reducedMotion, POPOVER_SPRING)}
                    className="fluid-material-strong absolute right-0 z-20 mt-1 w-44 origin-top-right overflow-hidden rounded-lg border border-border p-1"
                  >
                    <a role="menuitem" href="https://github.com/settings/applications" target="_blank" rel="noopener noreferrer"
                      className={cn("fluid-press flex min-h-11 items-center gap-2 rounded-md px-3 text-[11px] text-foreground hover:bg-secondary", CONTROL_FOCUS)}>
                      <ExternalLink className="size-3.5" aria-hidden="true" />管理授权
                    </a>
                    <button type="button" role="menuitem" onClick={onDisconnect}
                      className={cn("fluid-press flex min-h-11 w-full items-center gap-2 rounded-md border-t border-border/60 px-3 text-[11px] text-destructive hover:bg-destructive/10", CONTROL_FOCUS)}>
                      <X className="size-3.5" aria-hidden="true" />断开 GitHub
                    </button>
                  </motion.div>
                </motion.div>
              )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </header>
      {children}
    </div>
  )
}

export function RepoPicker({ repos, hidden, onLoad, onPick, onHide, onReset }: {
  repos: RepoItem[] | null
  hidden: string[]
  onLoad: () => void
  onPick: (fullName: string | null) => void
  onHide: (fullName: string) => void
  onReset: () => void
}) {
  useEffect(() => { if (repos === null) onLoad() }, [repos, onLoad])
  const visible = repos?.filter(repo => !hidden.includes(repo.full_name)) ?? null
  const hiddenCount = repos && visible ? repos.length - visible.length : 0
  return (
    <div className="fluid-scroll flex-1 overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-2xl space-y-2">
        <header className="mb-5">
          <h1 className="text-sm font-semibold text-foreground" style={{ fontFamily: MONO }}>选择工作区</h1>
          <p className="mt-1 text-[11px] text-muted-foreground">{visible?.length ?? 0} 个可用仓库</p>
        </header>
        <button type="button" onClick={() => onPick(null)}
          className={cn("fluid-press flex min-h-12 w-full items-center gap-3 rounded-lg border px-4 text-left hover:bg-secondary/50", CONTROL_FOCUS)} style={{ borderColor: ACCENT }}>
          <Plus className="size-4 shrink-0" style={{ color: ACCENT }} aria-hidden="true" /><span className="text-[12px] font-medium text-foreground" style={{ fontFamily: MONO }}>新建项目</span>
        </button>
        <h2 className="px-1 pt-3 text-[11px] font-medium text-muted-foreground" style={{ fontFamily: MONO }}>已有仓库</h2>
        {visible === null ? (
          <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-muted-foreground">没有可显示的仓库</p>
        ) : visible.map(repo => (
          <div key={repo.full_name} className="group flex min-h-12 w-full items-center gap-1 rounded-lg border border-border px-2 transition-colors hover:bg-secondary/50">
            <button type="button" onClick={() => onPick(repo.full_name)}
              className={cn("flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md px-2 text-left", CONTROL_FOCUS)}>
              <GitBranch className="size-4 shrink-0" style={{ color: ACCENT }} aria-hidden="true" />
              <span className="min-w-0 flex-1"><span className="block truncate text-[12px] text-foreground" style={{ fontFamily: MONO }}>{repo.full_name}</span>{repo.description && <span className="block truncate text-[10px] text-muted-foreground">{repo.description}</span>}</span>
              {repo.private && <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">私有</span>}
            </button>
            <button type="button" onClick={() => onHide(repo.full_name)} aria-label={`隐藏 ${repo.full_name}`} title="从列表隐藏"
              className={cn(ICON_CONTROL, CONTROL_FOCUS, "text-muted-foreground opacity-100 hover:bg-secondary hover:text-destructive sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100")}>
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
        {hiddenCount > 0 && <button type="button" onClick={onReset}
          className={cn("min-h-11 w-full rounded-md px-2 text-center text-[10px] text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground", CONTROL_FOCUS)}
          style={{ fontFamily: MONO }}>恢复 {hiddenCount} 个隐藏仓库</button>}
      </div>
    </div>
  )
}

function trapDialogFocus(
  event: KeyboardEvent<HTMLDivElement>,
  dialog: HTMLDivElement | null,
  onClose: () => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault()
    onClose()
    return
  }
  if (event.key !== "Tab" || !dialog) return
  const elements = [...dialog.querySelectorAll<HTMLElement>(
    "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )].filter(element => element.offsetParent !== null)
  if (!elements.length) return
  const first = elements[0]
  const last = elements.at(-1)!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function OverlayShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = useReducedMotion()
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    return () => previous?.focus()
  }, [])
  if (typeof document === "undefined") return null
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={transitionFor(reducedMotion)}
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/50 sm:items-center"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <motion.div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onKeyDown={event => trapDialogFocus(event, dialogRef.current, onClose)}
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98 }}
        transition={transitionFor(reducedMotion, PANEL_SPRING)}
        className="fluid-material-strong fluid-scroll relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-xl border border-border p-4 sm:rounded-lg">
        <div className="mb-3 flex min-h-11 items-center justify-between gap-3">
          <h2 id={titleId} className="min-w-0 truncate text-[12px] font-medium text-foreground" style={{ fontFamily: MONO }}>{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭"
            className={cn(ICON_CONTROL, CONTROL_FOCUS, "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>,
    document.body,
  )
}

export function SimpleOverlay({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return <OverlayShell title={title} onClose={onClose}><p className="text-[11px] text-muted-foreground">{text}</p></OverlayShell>
}

export function ModelOverlay({ tier, onPick, onClose }: { tier: Tier; onPick: (tier: Tier) => void; onClose: () => void }) {
  return (
    <OverlayShell title="切换模型" onClose={onClose}>
      <div className="space-y-1.5">
        {CODE_TIERS.map(option => <button type="button" key={option.id} onClick={() => onPick(option.id)} aria-pressed={tier === option.id}
          className={cn("flex min-h-11 w-full items-center gap-3 rounded-lg border px-4 text-left transition-colors hover:bg-secondary/60", CONTROL_FOCUS)}
          style={{ borderColor: tier === option.id ? ACCENT : "var(--border)" }}><span className="flex-1 text-[12px] text-foreground" style={{ fontFamily: MONO }}>{option.label}</span>{tier === option.id && <Check className="size-4" style={{ color: ACCENT }} aria-hidden="true" />}</button>)}
      </div>
    </OverlayShell>
  )
}

export function MemoryOverlay({ repo, userId, onClose }: { repo: string; userId: string; onClose: () => void }) {
  const [memories, setMemories] = useState<CodeMemory[] | null>(null)
  const [draft, setDraft] = useState("")
  useEffect(() => { fetchCodeMemories(repo).then(setMemories) }, [repo])
  async function addMemory() {
    const content = draft.trim()
    if (!content) return
    const memory = await insertCodeMemory(userId, repo, content)
    if (memory) setMemories(previous => [...(previous ?? []), memory])
    setDraft("")
  }
  function removeMemory(id: string) {
    setMemories(previous => (previous ?? []).filter(memory => memory.id !== id))
    void deleteCodeMemory(id)
  }
  return (
    <OverlayShell title={`本仓库记忆 · ${repo}`} onClose={onClose}>
      <div className="max-h-[40vh] space-y-1.5 overflow-y-auto">
        {memories === null ? <div role="status" aria-label="正在载入记忆" className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /></div> : memories.length === 0 ? <p className="py-3 text-center text-[11px] text-muted-foreground">还没有记忆</p> : memories.map(memory => <div key={memory.id} className="flex min-h-11 items-center gap-2 rounded-lg bg-secondary/50 pl-3"><span className="min-w-0 flex-1 break-words text-[11px] leading-relaxed text-foreground/90">{memory.content}</span><button type="button" onClick={() => removeMemory(memory.id)} aria-label="删除记忆" className={cn(ICON_CONTROL, CONTROL_FOCUS, "text-muted-foreground hover:bg-destructive/10 hover:text-destructive")}><Trash2 className="size-3.5" aria-hidden="true" /></button></div>)}
      </div>
      <div className="mt-2 flex gap-2">
        <label htmlFor="code-memory-input" className="sr-only">新记忆</label>
        <input id="code-memory-input" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void addMemory() }} placeholder="添加记忆" className={cn("min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-secondary/40 px-3 text-[11px] text-foreground outline-none", CONTROL_FOCUS)} />
        <button type="button" onClick={() => void addMemory()} aria-label="添加记忆" className={cn(ICON_CONTROL, CONTROL_FOCUS, "text-white")} style={{ background: ACCENT }}><Plus className="size-4" aria-hidden="true" /></button>
      </div>
    </OverlayShell>
  )
}

export function ContextOverlay({ messages, onClose }: { messages: CodeMessage[]; onClose: () => void }) {
  const characters = messages.reduce((sum, message) => sum + message.content.length + (message.plan?.reduce((planSum, action) => planSum + (action.kind === "write_file" ? action.newContent.length : 0), 0) ?? 0), 0)
  const estimate = Math.round(characters / 3)
  const maximum = 128_000
  const percentage = Math.min(100, (estimate / maximum) * 100)
  return (
    <OverlayShell title="上下文用量" onClose={onClose}>
      <div className="space-y-3" style={{ fontFamily: MONO }}><div className="flex justify-between text-[11px]"><span className="text-muted-foreground">消息条数</span><span className="text-foreground">{messages.length}</span></div><div className="flex justify-between text-[11px]"><span className="text-muted-foreground">约 token</span><span className="text-foreground">{estimate.toLocaleString()} / {maximum.toLocaleString()}</span></div><div role="progressbar" aria-label="上下文用量" aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={estimate} className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${percentage}%`, background: ACCENT }} /></div><p className="text-[10px] text-muted-foreground">估算值</p></div>
    </OverlayShell>
  )
}

export function ResumeOverlay({ repo, onPick, onClose }: { repo: string; onPick: (session: CodeSession) => void; onClose: () => void }) {
  const [sessions, setSessions] = useState<CodeSession[] | null>(null)
  useEffect(() => { fetchCodeSessions(repo).then(setSessions) }, [repo])
  return (
    <OverlayShell title={`历史排查 · ${repo}`} onClose={onClose}>
      <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
        {sessions === null ? <div role="status" aria-label="正在载入历史会话" className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" /></div> : sessions.length === 0 ? <p className="py-3 text-center text-[11px] text-muted-foreground">还没有历史会话</p> : sessions.map(session => <button type="button" key={session.id} onClick={() => onPick(session)} className={cn("flex min-h-11 w-full items-center gap-3 rounded-lg border border-border px-3 text-left transition-colors hover:bg-secondary/60", CONTROL_FOCUS)}><span className="min-w-0 flex-1 truncate text-[12px] text-foreground" style={{ fontFamily: MONO }}>{session.title}</span><span className="shrink-0 text-[10px] text-muted-foreground">{session.date}</span></button>)}
      </div>
    </OverlayShell>
  )
}

export function TasksOverlay({ onClose }: { onClose: () => void }) {
  return (
    <OverlayShell title="Agent 任务" onClose={onClose}>
      <div className="-mx-4 -mb-4 h-[min(65vh,560px)] overflow-hidden border-t border-border">
        <AgentTasksPanel onClose={onClose} showHeaderClose={false} />
      </div>
    </OverlayShell>
  )
}
