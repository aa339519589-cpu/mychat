"use client"

import { useEffect, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
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
import { ACCENT, MONO, type RepoItem } from "./shared"

export { MessageView, ThinkingTimer } from "./message-view"
export { computeDiff } from "./diff"
export { ACCENT, COMMANDS, MONO, planSummary, type Overlay, type RepoItem } from "./shared"
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
  return (
    <div className="paper-grain fixed inset-0 z-[60] flex flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 md:px-8">
        <button onClick={onExit} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
          <ChevronLeft className="size-4" />退出
        </button>
        <span className="text-[11px] tracking-[0.25em]" style={{ color: ACCENT, fontFamily: MONO }}>CODE</span>

        <div className="ml-auto flex items-center gap-2">
          {onToggleAuto && (
            <button onClick={onToggleAuto} title="自主模式" className="rounded-md border border-border px-2 py-1 text-[10px] transition-colors hover:bg-secondary" style={{ fontFamily: MONO, color: auto ? ACCENT : undefined, borderColor: auto ? ACCENT : undefined }}>
              {auto ? "自动" : "确认"}
            </button>
          )}
          {repo !== undefined && repo && (
            <button onClick={onSwitchRepo} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-foreground/80 transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
              <GitBranch className="size-3.5" style={{ color: ACCENT }} />{repo}
            </button>
          )}
          {repo !== undefined && !repo && login !== undefined && (
            <span className="rounded-md px-2 py-1 text-[11px] text-muted-foreground" style={{ fontFamily: MONO }}>新项目</span>
          )}
          {login !== undefined && (
            <div className="relative">
              <button onClick={onGhMenu} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
                {login ? `@${login}` : "GitHub"}<ChevronDown className="size-3" />
              </button>
              {ghMenu && (
                <>
                  <button className="fixed inset-0 z-10 cursor-default" aria-label="关闭" onClick={onCloseGh} />
                  <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
                    <a href="https://github.com/settings/applications" target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2.5 text-[11px] text-foreground transition-colors hover:bg-secondary">
                      <ExternalLink className="size-3.5" />管理授权
                    </a>
                    <button onClick={onDisconnect} className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2.5 text-[11px] text-destructive transition-colors hover:bg-destructive/10">
                      <X className="size-3.5" />断开 GitHub
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
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
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-2xl space-y-2">
        <button onClick={() => onPick(null)} className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-secondary/50" style={{ borderColor: ACCENT }}>
          <Plus className="size-4 shrink-0" style={{ color: ACCENT }} /><span className="text-[12px] font-medium text-foreground" style={{ fontFamily: MONO }}>从零做个新项目（我来建仓库）</span>
        </button>
        <p className="px-1 pt-2 text-[11px] text-muted-foreground" style={{ fontFamily: MONO }}>或选一个已有仓库改：</p>
        {visible === null ? (
          <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-muted-foreground">没有可显示的仓库</p>
        ) : visible.map(repo => (
          <div key={repo.full_name} className="group flex w-full items-center gap-2 rounded-lg border border-border px-4 py-2.5 transition-colors hover:bg-secondary/50">
            <button onClick={() => onPick(repo.full_name)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <GitBranch className="size-4 shrink-0" style={{ color: ACCENT }} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[12px] text-foreground" style={{ fontFamily: MONO }}>{repo.full_name}</span>{repo.description && <span className="block truncate text-[10px] text-muted-foreground">{repo.description}</span>}</span>
              {repo.private && <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[9px] text-muted-foreground">私有</span>}
            </button>
            <button onClick={() => onHide(repo.full_name)} aria-label="从列表移除" title="从列表移除（不会删除 GitHub 上的真实仓库）" className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-destructive group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
          </div>
        ))}
        {hiddenCount > 0 && <button onClick={onReset} className="w-full pt-2 text-center text-[10px] text-muted-foreground transition-colors hover:text-foreground" style={{ fontFamily: MONO }}>已隐藏 {hiddenCount} 个 · 点此恢复全部</button>}
      </div>
    </div>
  )
}

function OverlayShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  if (typeof document === "undefined") return null
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div onClick={event => event.stopPropagation()} className="relative w-full max-w-md rounded-t-2xl border border-border bg-card p-4 sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between"><span className="text-[12px] font-medium text-foreground" style={{ fontFamily: MONO }}>{title}</span><button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button></div>
        {children}
      </div>
    </div>,
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
        {CODE_TIERS.map(option => <button key={option.id} onClick={() => onPick(option.id)} className="flex w-full items-center gap-3 rounded-lg border px-4 py-2.5 text-left transition-colors hover:bg-secondary/60" style={{ borderColor: tier === option.id ? ACCENT : "var(--border)" }}><span className="flex-1 text-[12px] text-foreground" style={{ fontFamily: MONO }}>{option.label}</span>{tier === option.id && <Check className="size-4" style={{ color: ACCENT }} />}</button>)}
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
      <p className="mb-2 text-[10px] text-muted-foreground">只属于这个仓库，与系统记忆、其它仓库相互隔离。</p>
      <div className="max-h-[40vh] space-y-1.5 overflow-y-auto">
        {memories === null ? <div className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div> : memories.length === 0 ? <p className="py-3 text-center text-[11px] text-muted-foreground">还没有记忆</p> : memories.map(memory => <div key={memory.id} className="flex items-start gap-2 rounded-lg bg-secondary/50 px-3 py-2"><span className="flex-1 text-[11px] leading-relaxed text-foreground/90">{memory.content}</span><button onClick={() => removeMemory(memory.id)} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button></div>)}
      </div>
      <div className="mt-2 flex gap-2"><input value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void addMemory() }} placeholder="手动添加一条记忆…" className="flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[11px] text-foreground outline-none" /><button onClick={() => void addMemory()} className="rounded-lg px-3 py-2 text-white" style={{ background: ACCENT }}><Plus className="size-4" /></button></div>
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
      <div className="space-y-3" style={{ fontFamily: MONO }}><div className="flex justify-between text-[11px]"><span className="text-muted-foreground">消息条数</span><span className="text-foreground">{messages.length}</span></div><div className="flex justify-between text-[11px]"><span className="text-muted-foreground">约 token</span><span className="text-foreground">{estimate.toLocaleString()} / {maximum.toLocaleString()}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${percentage}%`, background: ACCENT }} /></div><p className="text-[10px] text-muted-foreground">估算值（按字符粗略折算），仅供参考。</p></div>
    </OverlayShell>
  )
}

export function ResumeOverlay({ repo, onPick, onClose }: { repo: string; onPick: (session: CodeSession) => void; onClose: () => void }) {
  const [sessions, setSessions] = useState<CodeSession[] | null>(null)
  useEffect(() => { fetchCodeSessions(repo).then(setSessions) }, [repo])
  return (
    <OverlayShell title={`历史排查 · ${repo}`} onClose={onClose}>
      <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
        {sessions === null ? <div className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div> : sessions.length === 0 ? <p className="py-3 text-center text-[11px] text-muted-foreground">还没有历史会话</p> : sessions.map(session => <button key={session.id} onClick={() => onPick(session)} className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-secondary/60"><span className="min-w-0 flex-1 truncate text-[12px] text-foreground" style={{ fontFamily: MONO }}>{session.title}</span><span className="shrink-0 text-[10px] text-muted-foreground">{session.date}</span></button>)}
      </div>
    </OverlayShell>
  )
}
