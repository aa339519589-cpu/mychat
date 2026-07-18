"use client"

import { useState } from "react"
import { Check, Feather, FolderPlus, Loader2, Plus, Trash2, X } from "lucide-react"

import type { Conversation } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import type { Project, ProjectFile } from "@/lib/project-data"
import { ConversationRow } from "./primitives"
import { ProjectFilesSection, ProjectInstructionsSection, ProjectMemorySection } from "./project-resources"
import { sortConversations, type SidebarAnchor } from "./shared"

export function ProjectsScreen({ projects, conversations, onCreate, onOpen, onDelete }: {
  projects: Project[]
  conversations: Conversation[]
  onCreate: (name: string) => Promise<Project | null>
  onOpen: (id: string) => void
  onDelete: (id: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState("")
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  async function create() {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    const p = await onCreate(n)
    setBusy(false)
    if (p) { setName(""); setAdding(false); onOpen(p.id) }
  }

  function requestDelete(projectId: string) {
    if (confirmDeleteId !== projectId) {
      setConfirmDeleteId(projectId)
      return
    }
    setConfirmDeleteId(null)
    onDelete(projectId)
  }

  const countFor = (pid: string) => conversations.filter(c => c.projectId === pid).length
  const filtered = projects.filter(p => p.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="flex flex-col px-4">
      <div className="mb-4 flex items-start gap-2">
        <div className="relative flex-1">
          <Feather className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-sidebar-primary/70" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索项目……"
            className="w-full rounded-xl bg-sidebar-accent/40 py-2 pl-10 pr-3 text-[12px] outline-none placeholder:text-muted-foreground/50 transition-colors border border-sidebar-primary/40 focus:bg-sidebar-accent/60 focus:border-sidebar-primary/70"
          />
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="shrink-0 rounded-lg bg-sidebar-primary p-1.5 text-sidebar-primary-foreground transition-colors hover:bg-sidebar-primary/90" title="新建项目">
            <FolderPlus className="size-4" />
          </button>
        )}
      </div>
      {adding && (
        <div className="mb-4 space-y-2">
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); create() } if (e.key === "Escape") { setAdding(false); setName("") } }}
            placeholder="项目名称……"
            className="w-full rounded-xl bg-sidebar-accent/40 px-3 py-2 text-[12px] outline-none placeholder:text-muted-foreground/40 focus:bg-sidebar-accent/60 border border-sidebar-primary/40"
          />
          <div className="flex gap-2">
            <button onClick={create} disabled={busy} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[12px] text-sidebar-primary-foreground disabled:opacity-50">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}新建
            </button>
            <button onClick={() => { setAdding(false); setName("") }} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/40 py-1.5 text-[12px] text-muted-foreground"><X className="size-3.5" />取消</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2">
        {filtered.length === 0 ? (
          <p className="rounded-2xl bg-sidebar-accent/20 px-4 py-8 text-center text-[12px] italic text-muted-foreground/70">没有项目</p>
        ) : (
          filtered.map(p => {
            const n = countFor(p.id)
            const confirmingDelete = confirmDeleteId === p.id
            return (
              <div
                key={p.id}
                className="group relative rounded-2xl border border-sidebar-accent/60 bg-sidebar-accent/35 transition-colors hover:border-sidebar-accent/80 hover:bg-sidebar-accent/50"
              >
                <button
                  onClick={() => { setConfirmDeleteId(null); onOpen(p.id) }}
                  className="fluid-press block w-full rounded-2xl px-4 py-3 pr-16 text-left active:scale-[0.99]"
                >
                  <div className="font-heading text-[13px] tracking-wide text-foreground">{p.name}</div>
                  {p.instructions && (
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{p.instructions}</p>
                  )}
                  <div className="mt-2 text-[10px] text-muted-foreground">{n > 0 ? `${n} 段对谈 · ` : ""}{p.date}</div>
                </button>
                <button
                  onClick={() => requestDelete(p.id)}
                  onBlur={() => { if (confirmingDelete) setConfirmDeleteId(null) }}
                  aria-label={confirmingDelete ? `确认删除项目 ${p.name}` : `删除项目 ${p.name}`}
                  title={confirmingDelete ? "再次点击确认删除" : "删除项目"}
                  className={`fluid-press fluid-icon-press fluid-touch-target absolute right-1 top-1/2 flex min-w-11 -translate-y-1/2 items-center justify-center rounded-full px-2 text-[11px] transition-colors md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 ${confirmingDelete ? "bg-destructive/10 text-destructive" : "text-muted-foreground/60 hover:bg-sidebar-accent hover:text-destructive"}`}
                >
                  {confirmingDelete ? "确认" : <Trash2 className="size-4" />}
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── 项目详情＝工作台（单页纵向滚动）：起新对谈 + 对谈列表 + 记忆/指令/资料分组 ──
// 重命名、删除收进顶部 ⋯ 菜单（由 ScreenPanel 的 action 触发），此处不再出现管理型大按钮。
export function ProjectDetailScreen({
  project, conversations, onOpenChat, onNewChat,
  onInstructions, onLoadFiles, onAddFile, onDeleteFile,
  onLoadProjectMemories, onAddProjectMemory, onEditProjectMemory, onDeleteProjectMemory,
  renamingId, onOpenConvMenu, onRenameConversation, onStopRename,
}: {
  project: Project
  conversations: Conversation[]
  onOpenChat: (id: string) => void
  onNewChat: (projectId: string) => void
  onInstructions: (id: string, instructions: string) => void
  onLoadFiles: (projectId: string) => Promise<ProjectFile[]>
  onAddFile: (projectId: string, file: File) => Promise<ProjectFile | null>
  onDeleteFile: (fileId: string) => void
  onLoadProjectMemories: (projectId: string) => Promise<Memory[]>
  onAddProjectMemory: (content: string) => Promise<Memory | null>
  onEditProjectMemory: (id: string, content: string) => void
  onDeleteProjectMemory: (id: string) => void
  renamingId: string | null
  onOpenConvMenu: (id: string, anchor: SidebarAnchor) => void
  onRenameConversation: (id: string, title: string) => void
  onStopRename: () => void
}) {
  const chats = sortConversations(conversations.filter(c => c.projectId === project.id && !c.draft))

  return (
    <div className="space-y-5 px-4">
      {/* 起新对谈：本项目的主要入口 */}
      <button
        onClick={() => onNewChat(project.id)}
        className="flex w-full items-center gap-2.5 rounded-2xl bg-sidebar-primary/12 px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-sidebar-primary/20 active:scale-[0.99]"
      >
        <Plus className="size-4 text-sidebar-primary" />在此项目中起新对谈
      </button>

      {/* 对谈列表 */}
      <section>
        <p className="mb-2 px-1 text-[10px] tracking-[0.18em] text-muted-foreground/70">本项目对谈{chats.length > 0 ? ` · ${chats.length}` : ""}</p>
        {chats.length === 0 ? (
          <p className="rounded-2xl bg-sidebar-accent/25 px-4 py-6 text-center text-[12px] italic text-muted-foreground/70">还没有对谈，从上方开始第一段</p>
        ) : (
          <div className="space-y-1">
            {chats.map(c => (
              <ConversationRow
                key={c.id}
                c={c}
                isActive={false}
                renaming={renamingId === c.id}
                onSelect={onOpenChat}
                onOpenMenu={onOpenConvMenu}
                onCommitRename={(id, t) => { onRenameConversation(id, t); onStopRename() }}
                onCancelRename={onStopRename}
              />
            ))}
          </div>
        )}
      </section>

      {/* 工作台分组卡：记忆 / 项目指令 / 资料 —— 一张卡内三段，靠分隔线区隔（学 Claude 项目页） */}
      <div className="divide-y divide-sidebar-border/60 overflow-hidden rounded-2xl border border-sidebar-border bg-sidebar-accent/25">
        <ProjectMemorySection
          projectId={project.id}
          onLoad={onLoadProjectMemories}
          onAdd={onAddProjectMemory}
          onEdit={onEditProjectMemory}
          onDelete={onDeleteProjectMemory}
        />
        <ProjectInstructionsSection value={project.instructions} onSave={v => onInstructions(project.id, v)} />
        <ProjectFilesSection project={project} onLoadFiles={onLoadFiles} onAddFile={onAddFile} onDeleteFile={onDeleteFile} />
      </div>
    </div>
  )
}

// 顶部就地改名输入框（替换 ScreenPanel 标题）
export function ProjectTitleEditor({ name, onSave, onCancel }: { name: string; onSave: (n: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(name)
  return (
    <input
      autoFocus
      value={v}
      onChange={e => setV(e.target.value)}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.preventDefault()
          const n = v.trim()
          if (n) onSave(n)
          else onCancel()
        }
        if (e.key === "Escape") onCancel()
      }}
      onBlur={() => {
        const n = v.trim()
        if (n && n !== name) onSave(n)
        else onCancel()
      }}
      className="w-full rounded-lg border border-sidebar-border bg-background/50 px-2.5 py-1 text-[15px] font-semibold outline-none focus:border-sidebar-primary/50"
    />
  )
}

// 项目级记忆：独立于全局记忆，仅在该项目对话时注入上下文
