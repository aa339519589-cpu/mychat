"use client"

import { useState, useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import type { Conversation } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import type { Project, ProjectFile } from "@/lib/project-data"
import { cn } from "@/lib/utils"
import {
  Feather, Plus, ChevronLeft, ChevronRight, Trash2, Brain, LogOut,
  Settings, Folder, Shapes, Pencil, Check, X, PanelLeft,
  FileText, Upload, MessageCircle, Loader2, FolderPlus,
  MoreHorizontal, Star, Pin, SlidersHorizontal, BarChart2,
} from "lucide-react"
import { fetchQuota, fetchCustomSystemPrompt, saveCustomSystemPrompt, type QuotaSnapshot } from "@/lib/db"

// 二级页面：除根视图（侧栏主体）外的所有可滑入页面
type Screen = "settings" | "memory" | "projects" | "artifacts" | "project-detail" | "basics" | "quota"

// 层级 z：从根进入的为一级(20)，从设置再进入的为二级(30)，均高于根面板(10)。
// 同级页面从不同时出现，静态 z 即可，退场时仍盖在被揭开的页面之上，滑出动画才完整。
const Z: Record<Screen, number> = {
  settings: 20, projects: 20, artifacts: 20,
  memory: 30, "project-detail": 30, "basics": 30, "quota": 30,
}

// 置顶的排在最前；同组内保持原顺序（V8 的 sort 稳定）
const sortConvs = (list: Conversation[]) => [...list].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))

// 会话"更多菜单"锚点：⋯ 按钮的视口坐标（把弹层定位到它旁边）
type Anchor = { top: number; bottom: number; right: number }

export type AppSidebarProps = {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  memories: Memory[]
  onMemoryAdd: (content: string) => void
  onMemoryEdit: (id: string, content: string) => void
  onMemoryDelete: (id: string) => void
  memoryEnabled: boolean
  onMemoryEnabledChange: (v: boolean) => void
  projects: Project[]
  onProjectCreate: (name: string) => Promise<Project | null>
  onProjectRename: (id: string, name: string) => void
  onProjectInstructions: (id: string, instructions: string) => void
  onProjectDelete: (id: string) => void
  onNewInProject: (projectId: string) => void
  onLoadProjectFiles: (projectId: string) => Promise<ProjectFile[]>
  onAddProjectFile: (projectId: string, file: File) => Promise<ProjectFile | null>
  onDeleteProjectFile: (fileId: string) => void
  onToggleStar: (id: string) => void
  onTogglePin: (id: string) => void
  onRenameConversation: (id: string, title: string) => void
  onAddToProject: (id: string, projectId: string | null) => void
  userEmail: string
  onLogout: () => void
}

// mobile：一级侧栏只占半屏（露出后面的对话），二级页面铺满整屏
// 桌面：侧栏常驻于 20rem 容器内，二级页面在容器内滑动
export function AppSidebar({
  mobile = false, visible = true, onClose, ...props
}: AppSidebarProps & { mobile?: boolean; visible?: boolean; onClose?: () => void }) {
  const { conversations, activeId, onDelete, userEmail, onLogout } = props
  const [stack, setStack] = useState<Screen[]>([])
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [actionConvId, setActionConvId] = useState<string | null>(null)   // 打开"更多菜单"的会话
  const [actionAnchor, setActionAnchor] = useState<Anchor | null>(null)   // ⋯ 按钮的位置
  const [actionProjectPicker, setActionProjectPicker] = useState(false)   // 菜单内"添加进项目"二级
  const [renamingId, setRenamingId] = useState<string | null>(null)       // 正在改名的会话

  // 抽屉收起后复位到根视图
  useEffect(() => { if (!visible) { setStack([]); setUserMenuOpen(false); setSelectedProjectId(null); setActionConvId(null); setRenamingId(null) } }, [visible])

  const push = (s: Screen) => { setUserMenuOpen(false); setStack(prev => [...prev, s]) }
  const pop = () => setStack(prev => prev.slice(0, -1))
  const openProject = (id: string) => { setSelectedProjectId(id); push("project-detail") }
  const selectedProject = props.projects.find(p => p.id === selectedProjectId) ?? null
  const openConvMenu = (id: string, anchor: Anchor) => { setActionProjectPicker(false); setActionAnchor(anchor); setActionConvId(id) }
  const closeConvMenu = () => { setActionConvId(null); setActionProjectPicker(false) }
  const actionConv = conversations.find(c => c.id === actionConvId) ?? null
  // 根列表显示所有非草稿对谈（包括项目对话）；置顶在前
  const rootConversations = sortConvs(conversations.filter(c => !c.draft))
  const handleSelect = (id: string) => { setStack([]); setUserMenuOpen(false); props.onSelect(id) }
  const handleNew = () => { setStack([]); setUserMenuOpen(false); props.onNew() }

  function screenStyle(s: Screen): React.CSSProperties {
    const inStack = stack.includes(s)
    return {
      transform: inStack ? "translateX(0)" : "translateX(100%)",
      zIndex: Z[s],
      pointerEvents: inStack ? "auto" : "none",
    }
  }

  const initial = (userEmail.slice(0, 1) || "我").toUpperCase()

  const rootContent = (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <Feather className="size-4 text-sidebar-primary" />
        <span className="font-heading text-base tracking-wide">简</span>
        {mobile && onClose && (
          <button onClick={onClose} aria-label="收起侧栏" className="ml-auto rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground">
            <PanelLeft className="size-5" />
          </button>
        )}
      </div>

      <button
        onClick={handleNew}
        className="mx-4 mb-2 flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
      >
        <Plus className="size-4 text-sidebar-primary" />
        起一篇新的对谈
      </button>

      <nav className="mx-4 space-y-0.5">
        <NavRow icon={<Folder className="size-4" />} label="项目" onClick={() => push("projects")} />
        <NavRow icon={<Shapes className="size-4" />} label="作品" onClick={() => push("artifacts")} />
      </nav>

      <div className="mx-7 my-3 border-t border-sidebar-border/60" />
      <p className="px-7 pb-2 text-[11px] tracking-[0.2em] text-muted-foreground/70">近期</p>

      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {rootConversations.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] italic text-muted-foreground/60">还没有对谈</p>
        ) : rootConversations.map(c => (
          <ConversationRow
            key={c.id}
            c={c}
            isActive={c.id === activeId}
            renaming={renamingId === c.id}
            onSelect={handleSelect}
            onOpenMenu={openConvMenu}
            onCommitRename={(id, t) => { props.onRenameConversation(id, t); setRenamingId(null) }}
            onCancelRename={() => setRenamingId(null)}
          />
        ))}
      </div>

      {/* 用户页脚 */}
      <div className="border-t border-sidebar-border px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <button
          onClick={() => setUserMenuOpen(v => !v)}
          className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/60"
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/15 text-sm text-sidebar-primary">{initial}</div>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{userEmail || "已登录"}</span>
          <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", userMenuOpen && "-rotate-90")} />
        </button>
      </div>

      {/* 用户菜单：设置 / 退出（覆盖层 + 点外部收起） */}
      {userMenuOpen && (
        <div className="absolute inset-0 z-30">
          <button className="absolute inset-0 cursor-default" aria-label="关闭菜单" onClick={() => setUserMenuOpen(false)} />
          <div className="absolute bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] left-3 right-3 overflow-hidden rounded-2xl border border-sidebar-border bg-card shadow-lg">
            <button onClick={() => push("settings")} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-foreground transition-colors hover:bg-sidebar-accent/60">
              <Settings className="size-4 text-muted-foreground" />设置
            </button>
            <div className="border-t border-sidebar-border/50" />
            <button onClick={onLogout} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-destructive">
              <LogOut className="size-4" />退出登录
            </button>
          </div>
        </div>
      )}
    </div>
  )

  const screens = (
    <>
      <ScreenPanel style={screenStyle("settings")} title="设置" onBack={pop}>
        <div className="space-y-1 px-3">
          <MenuRow icon={<Brain className="size-4" />} label="记忆" hint={`${props.memories.length} 条`} onClick={() => push("memory")} />
          <MenuRow icon={<BarChart2 className="size-4" />} label="使用额度" onClick={() => push("quota")} />
          <MenuRow icon={<SlidersHorizontal className="size-4" />} label="基础设定" onClick={() => push("basics")} />
        </div>
      </ScreenPanel>

      <ScreenPanel style={screenStyle("memory")} title="记忆" onBack={pop}>
        <MemoryScreen
          memories={props.memories}
          enabled={props.memoryEnabled}
          onEnabledChange={props.onMemoryEnabledChange}
          onAdd={props.onMemoryAdd}
          onEdit={props.onMemoryEdit}
          onDelete={props.onMemoryDelete}
        />
      </ScreenPanel>

      <ScreenPanel style={screenStyle("quota")} title="使用额度" onBack={pop}>
        <QuotaScreen />
      </ScreenPanel>

      <ScreenPanel style={screenStyle("basics")} title="基础设定" onBack={pop}>
        <BasicsScreen />
      </ScreenPanel>

      <ScreenPanel style={screenStyle("projects")} title="项目" onBack={pop}>
        <ProjectsScreen
          projects={props.projects}
          conversations={conversations}
          onCreate={props.onProjectCreate}
          onOpen={openProject}
          onDelete={props.onProjectDelete}
        />
      </ScreenPanel>

      <ScreenPanel style={screenStyle("project-detail")} title={selectedProject?.name ?? "项目"} onBack={pop}>
        {selectedProject && (
          <ProjectDetailScreen
            key={selectedProject.id}
            project={selectedProject}
            conversations={conversations}
            onOpenChat={handleSelect}
            onNewChat={props.onNewInProject}
            onRename={props.onProjectRename}
            onInstructions={props.onProjectInstructions}
            onDeleteProject={(id) => { props.onProjectDelete(id); pop() }}
            onLoadFiles={props.onLoadProjectFiles}
            onAddFile={props.onAddProjectFile}
            onDeleteFile={props.onDeleteProjectFile}
            renamingId={renamingId}
            onOpenConvMenu={openConvMenu}
            onRenameConversation={props.onRenameConversation}
            onStopRename={() => setRenamingId(null)}
          />
        )}
      </ScreenPanel>

      <ScreenPanel style={screenStyle("artifacts")} title="作品" onBack={pop}>
        <ComingSoon
          icon={<Shapes className="size-7" />}
          title="作品库即将上线"
          desc="你与小克共同创作过的可交互页面会收藏在这里，随时回看、下载。"
        />
      </ScreenPanel>
    </>
  )

  // 会话「更多菜单」：锚定在 ⋯ 旁的弹层（portal 到 body，避免被滚动容器/抽屉变换裁切）
  const convMenu = actionConv && actionAnchor && (
    <ConvMenu
      conv={actionConv}
      anchor={actionAnchor}
      projects={props.projects}
      picker={actionProjectPicker}
      onPicker={setActionProjectPicker}
      onClose={closeConvMenu}
      onToggleStar={() => { props.onToggleStar(actionConv.id); closeConvMenu() }}
      onTogglePin={() => { props.onTogglePin(actionConv.id); closeConvMenu() }}
      onStartRename={() => { setRenamingId(actionConv.id); closeConvMenu() }}
      onAddToProject={(pid) => { props.onAddToProject(actionConv.id, pid); closeConvMenu() }}
      onDelete={() => { onDelete(actionConv.id); closeConvMenu() }}
    />
  )

  // 手机：一级半屏面板（滑入/滑出）+ 二级整屏页面（相对外层 fixed 容器铺满）
  if (mobile) {
    return (
      <>
        <div className={cn(
          "absolute left-0 top-0 z-10 h-full w-[min(20rem,82vw)] overflow-hidden bg-sidebar text-sidebar-foreground shadow-2xl transition-transform duration-300 ease-out",
          visible ? "translate-x-0" : "-translate-x-full",
        )}>
          {rootContent}
        </div>
        {screens}
        {convMenu}
      </>
    )
  }

  // 桌面：常驻侧栏，二级页面在 20rem 容器内滑动
  return (
    <aside className="relative flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      {rootContent}
      {screens}
      {convMenu}
    </aside>
  )
}

// ── 二级页面外壳：统一返回头 + 滑动动画 ──
function ScreenPanel({ style, title, onBack, children }: {
  style: React.CSSProperties
  title: string
  onBack: () => void
  children: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 flex flex-col bg-sidebar transition-transform duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)]" style={style}>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button onClick={onBack} className="-ml-1 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="返回">
          <ChevronLeft className="size-5" />
        </button>
        <h3 className="text-[17px] font-semibold tracking-tight">{title}</h3>
      </div>
      <div className="flex-1 overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
    </div>
  )
}

function NavRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent">
      <span className="text-muted-foreground">{icon}</span>{label}
    </button>
  )
}

function MenuRow({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left transition-colors hover:bg-sidebar-accent/60">
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-sm text-foreground">{label}</span>
      {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      <ChevronRight className="size-4 text-muted-foreground/50" />
    </button>
  )
}

function ComingSoon({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="mx-auto flex h-full max-w-xs flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-sidebar-accent/60 text-sidebar-primary">{icon}</div>
      <p className="font-heading text-base tracking-wide text-foreground">{title}</p>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  )
}

function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-sidebar-primary" : "bg-muted-foreground/30")}
    >
      <span className={cn("absolute left-0.5 top-0.5 size-5 rounded-full bg-card shadow transition-transform", checked && "translate-x-5")} />
    </button>
  )
}

function MemoryScreen({ memories, enabled, onEnabledChange, onAdd, onEdit, onDelete }: {
  memories: Memory[]
  enabled: boolean
  onEnabledChange: (v: boolean) => void
  onAdd: (content: string) => void
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [newValue, setNewValue] = useState("")
  const [adding, setAdding] = useState(false)

  function startEdit(m: Memory) { setEditingId(m.id); setEditValue(m.content) }
  function saveEdit() {
    if (!editingId || !editValue.trim()) return
    onEdit(editingId, editValue.trim()); setEditingId(null)
  }
  function addMemory() {
    if (!newValue.trim()) return
    onAdd(newValue.trim()); setNewValue(""); setAdding(false)
  }

  return (
    <div className="px-4">
      <div className="flex items-start gap-3 rounded-2xl bg-sidebar-accent/55 border border-sidebar-border p-4">
        <Brain className="mt-0.5 size-5 shrink-0 text-sidebar-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">开启记忆</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            开启后，小克会在对谈中记住你透露的信息，并在需要时调用。关闭后，它既不会读取也不会写入任何记忆。
          </p>
        </div>
        <Switch checked={enabled} onChange={onEnabledChange} />
      </div>

      <div className={cn("mt-4 transition-opacity", !enabled && "opacity-40")}>
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[12px] tracking-[0.15em] text-muted-foreground">已记住 {memories.length} 条</span>
        </div>

        <div className="space-y-2">
          {memories.length === 0 && !adding && (
            <p className="rounded-2xl bg-sidebar-accent/55 border border-sidebar-border px-4 py-6 text-center text-[13px] italic text-muted-foreground/70">还没有记忆</p>
          )}

          {memories.map(m => (
            <div key={m.id} className="rounded-2xl bg-sidebar-accent/55 border border-sidebar-border px-3 py-2.5">
              {editingId === m.id ? (
                <div className="space-y-2">
                  <textarea
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit() } if (e.key === "Escape") setEditingId(null) }}
                    className="w-full resize-none rounded-xl bg-sidebar-accent/60 border border-sidebar-accent/70 px-3 py-2 text-[13px] outline-none focus:bg-sidebar-accent/80"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[13px] text-sidebar-primary-foreground"><Check className="size-3.5" />保存</button>
                    <button onClick={() => setEditingId(null)} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/60 py-1.5 text-[13px] text-muted-foreground"><X className="size-3.5" />取消</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-[13px] leading-relaxed text-foreground/85">{m.content}</p>
                  <div className="flex shrink-0 gap-0.5">
                    <button onClick={() => startEdit(m)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="编辑"><Pencil className="size-3.5" /></button>
                    <button onClick={() => onDelete(m.id)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除"><Trash2 className="size-3.5" /></button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {adding ? (
            <div className="space-y-2 rounded-2xl bg-sidebar-accent/55 border border-sidebar-border px-3 py-2.5">
              <textarea
                autoFocus
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMemory() } if (e.key === "Escape") setAdding(false) }}
                placeholder="输入要记住的内容……"
                className="w-full resize-none rounded-xl bg-sidebar-accent/60 border border-sidebar-accent/70 px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground/40 focus:bg-sidebar-accent/80"
                rows={2}
              />
              <div className="flex gap-2">
                <button onClick={addMemory} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[13px] text-sidebar-primary-foreground"><Check className="size-3.5" />添加</button>
                <button onClick={() => setAdding(false)} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/60 py-1.5 text-[13px] text-muted-foreground"><X className="size-3.5" />取消</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 rounded-2xl bg-sidebar-accent/55 border border-sidebar-border py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground">
              <Plus className="size-4" />手动添加记忆
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 项目列表（一级页面内容）：新建 + 项目卡片 ──
function ProjectsScreen({ projects, conversations, onCreate, onOpen, onDelete }: {
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

  async function create() {
    const n = name.trim()
    if (!n || busy) return
    setBusy(true)
    const p = await onCreate(n)
    setBusy(false)
    if (p) { setName(""); setAdding(false); onOpen(p.id) }
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
            className="w-full rounded-xl bg-sidebar-accent/40 py-2 pl-10 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/50 transition-colors border border-sidebar-primary/40 focus:bg-sidebar-accent/60 focus:border-sidebar-primary/70"
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
            className="w-full rounded-xl bg-sidebar-accent/40 px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground/40 focus:bg-sidebar-accent/60 border border-sidebar-primary/40"
          />
          <div className="flex gap-2">
            <button onClick={create} disabled={busy} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[13px] text-sidebar-primary-foreground disabled:opacity-50">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}新建
            </button>
            <button onClick={() => { setAdding(false); setName("") }} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/40 py-1.5 text-[13px] text-muted-foreground"><X className="size-3.5" />取消</button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto space-y-2">
        {filtered.length === 0 ? (
          <p className="rounded-2xl bg-sidebar-accent/20 px-4 py-8 text-center text-[13px] italic text-muted-foreground/70">没有项目</p>
        ) : (
          filtered.map(p => {
            const n = countFor(p.id)
            return (
              <button
                key={p.id}
                onClick={() => onOpen(p.id)}
                className="group relative flex w-full flex-col gap-2 rounded-2xl bg-sidebar-accent/35 border border-sidebar-accent/60 px-4 py-3 text-left transition-colors hover:bg-sidebar-accent/50 hover:border-sidebar-accent/80 active:scale-[0.99]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-heading text-[14px] tracking-wide text-foreground">{p.name}</div>
                    {p.instructions && (
                      <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">{p.instructions}</p>
                    )}
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(p.id) }}
                    className="shrink-0 rounded-lg p-1 text-muted-foreground/40 transition-colors hover:bg-sidebar-accent hover:text-destructive opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="text-[11px] text-muted-foreground">{n > 0 ? `${n} 段对谈 · ` : ""}{p.date}</div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── 项目详情（二级页面内容）：指令/人设 + 对谈 / 资料 ──
function ProjectDetailScreen({
  project, conversations, onOpenChat, onNewChat,
  onRename, onInstructions, onDeleteProject, onLoadFiles, onAddFile, onDeleteFile,
  renamingId, onOpenConvMenu, onRenameConversation, onStopRename,
}: {
  project: Project
  conversations: Conversation[]
  onOpenChat: (id: string) => void
  onNewChat: (projectId: string) => void
  onRename: (id: string, name: string) => void
  onInstructions: (id: string, instructions: string) => void
  onDeleteProject: (id: string) => void
  onLoadFiles: (projectId: string) => Promise<ProjectFile[]>
  onAddFile: (projectId: string, file: File) => Promise<ProjectFile | null>
  onDeleteFile: (fileId: string) => void
  renamingId: string | null
  onOpenConvMenu: (id: string, anchor: Anchor) => void
  onRenameConversation: (id: string, title: string) => void
  onStopRename: () => void
}) {
  const [tab, setTab] = useState<"chats" | "sources">("chats")
  const chats = conversations.filter(c => c.projectId === project.id && !c.draft)

  return (
    <div className="px-4">
      <InstructionsCard value={project.instructions} onSave={v => onInstructions(project.id, v)} />

      <div className="mb-3 mt-4 flex gap-2">
        <TabButton active={tab === "chats"} onClick={() => setTab("chats")}>对谈{chats.length > 0 ? ` ${chats.length}` : ""}</TabButton>
        <TabButton active={tab === "sources"} onClick={() => setTab("sources")}>资料</TabButton>
      </div>

      {tab === "chats" ? (
        <ProjectChatsTab
          project={project} chats={chats}
          onOpenChat={onOpenChat} onNewChat={onNewChat}
          renamingId={renamingId} onOpenConvMenu={onOpenConvMenu}
          onRenameConversation={onRenameConversation} onStopRename={onStopRename}
        />
      ) : (
        <ProjectSourcesTab project={project} onLoadFiles={onLoadFiles} onAddFile={onAddFile} onDeleteFile={onDeleteFile} />
      )}

      <div className="mt-8 space-y-1 border-t border-sidebar-border/50 pt-4">
        <RenameRow project={project} onRename={onRename} />
        <button onClick={() => onDeleteProject(project.id)} className="flex w-full items-center justify-center gap-1.5 rounded-2xl py-2.5 text-[13px] text-muted-foreground transition-colors hover:text-destructive">
          <Trash2 className="size-3.5" />删除此项目
        </button>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn("rounded-full px-4 py-1.5 text-sm transition-colors", active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
      {children}
    </button>
  )
}

// 项目指令 / 人设：点开成多行编辑器
function InstructionsCard({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])

  if (editing) {
    return (
      <div className="space-y-2 rounded-2xl bg-sidebar-accent/30 p-3">
        <p className="text-[12px] font-medium tracking-[0.08em] text-muted-foreground">项目指令 / 人设</p>
        <textarea
          autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          placeholder="例如：你是我的英语学习教练，回答时多结合本项目里的资料……"
          className="w-full resize-none rounded-xl border border-sidebar-border bg-background/50 px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/40 focus:border-sidebar-primary/50"
          rows={4}
        />
        <div className="flex gap-2">
          <button onClick={() => { onSave(draft.trim()); setEditing(false) }} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[13px] text-sidebar-primary-foreground"><Check className="size-3.5" />保存</button>
          <button onClick={() => { setDraft(value); setEditing(false) }} className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-sidebar-border py-1.5 text-[13px] text-muted-foreground"><X className="size-3.5" />取消</button>
        </div>
      </div>
    )
  }

  const text = value.trim() || "设定后，本项目每段对谈都会自动沿用。点此编辑。"
  const lineCount = text.split('\n').length
  const isTruncated = lineCount > 3 || text.length > 200

  return (
    <button
      onClick={() => expanded ? setExpanded(false) : setEditing(true)}
      className="flex w-full items-start gap-3 rounded-2xl bg-sidebar-accent/30 p-3 text-left transition-colors hover:bg-sidebar-accent/55"
    >
      <Pencil className="mt-0.5 size-4 shrink-0 text-sidebar-primary" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">项目指令 / 人设</span>
        <span className={cn("mt-0.5 block text-[12px] leading-relaxed text-muted-foreground", !expanded && "line-clamp-3")}>
          {text}
        </span>
        {isTruncated && !expanded && (
          <button
            onClick={e => { e.stopPropagation(); setExpanded(true) }}
            className="mt-1 text-[11px] text-sidebar-primary transition-colors hover:text-sidebar-primary/80"
          >
            展开全文
          </button>
        )}
        {isTruncated && expanded && (
          <button
            onClick={e => { e.stopPropagation(); setExpanded(false) }}
            className="mt-1 text-[11px] text-sidebar-primary transition-colors hover:text-sidebar-primary/80"
          >
            收起
          </button>
        )}
      </span>
    </button>
  )
}

function ProjectChatsTab({ project, chats, onOpenChat, onNewChat, renamingId, onOpenConvMenu, onRenameConversation, onStopRename }: {
  project: Project
  chats: Conversation[]
  onOpenChat: (id: string) => void
  onNewChat: (projectId: string) => void
  renamingId: string | null
  onOpenConvMenu: (id: string, anchor: Anchor) => void
  onRenameConversation: (id: string, title: string) => void
  onStopRename: () => void
}) {
  const list = sortConvs(chats)
  return (
    <div className="space-y-1">
      <button onClick={() => onNewChat(project.id)} className="mb-1 flex w-full items-center gap-2.5 rounded-2xl bg-sidebar-accent/40 px-3 py-2.5 text-sm tracking-wide text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70">
        <Plus className="size-4 text-sidebar-primary" />在此项目中起新对谈
      </button>
      {list.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <MessageCircle className="mb-3 size-7 text-muted-foreground/40" />
          <p className="text-[13px] text-muted-foreground">还没有对谈</p>
          <p className="mt-1 text-[12px] text-muted-foreground/60">在上方新建，开始这个项目的第一段对话</p>
        </div>
      ) : list.map(c => (
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
  )
}

function ProjectSourcesTab({ project, onLoadFiles, onAddFile, onDeleteFile }: {
  project: Project
  onLoadFiles: (projectId: string) => Promise<ProjectFile[]>
  onAddFile: (projectId: string, file: File) => Promise<ProjectFile | null>
  onDeleteFile: (fileId: string) => void
}) {
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    onLoadFiles(project.id).then(fs => { if (!cancelled) { setFiles(fs); setLoading(false) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ""
    if (!picked.length) return
    setErr(null); setUploading(true)
    for (const f of picked) {
      const added = await onAddFile(project.id, f)
      if (added) setFiles(prev => [...prev, added])
      else setErr(`「${f.name}」添加失败，目前仅支持 PDF 和文本文件`)
    }
    setUploading(false)
  }

  function remove(id: string) {
    setFiles(prev => prev.filter(f => f.id !== id))
    onDeleteFile(id)
  }

  return (
    <div className="space-y-1">
      <input ref={inputRef} type="file" multiple
        accept=".pdf,.txt,.md,.markdown,.csv,.json,.log,.xml,.yaml,.yml,.html,.htm,text/*"
        className="hidden" onChange={handlePick} />
      <button onClick={() => inputRef.current?.click()} disabled={uploading} className="mb-1 flex w-full items-center gap-2.5 rounded-2xl bg-sidebar-accent/40 px-3 py-2.5 text-sm tracking-wide text-sidebar-foreground transition-colors hover:bg-sidebar-accent/70 disabled:opacity-50">
        {uploading ? <Loader2 className="size-4 animate-spin text-sidebar-primary" /> : <Upload className="size-4 text-sidebar-primary" />}
        {uploading ? "正在添加……" : "添加资料"}
      </button>
      {err && <p className="px-3 pb-1 text-[12px] text-destructive">{err}</p>}

      {loading ? (
        <p className="px-4 py-8 text-center text-[13px] italic text-muted-foreground/60">载入中……</p>
      ) : files.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <FileText className="mb-3 size-7 text-muted-foreground/40" />
          <p className="text-[13px] text-muted-foreground">还没有资料</p>
          <p className="mt-1 text-[12px] text-muted-foreground/60">上传 PDF 或文本，项目里的对谈会以它为参考</p>
        </div>
      ) : files.map(f => (
        <div key={f.id} className="group relative flex items-center gap-3 rounded-2xl px-3 py-2.5 pr-9 transition-colors hover:bg-sidebar-accent/40">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sidebar-primary/10 text-sidebar-primary"><FileText className="size-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{f.name}</span>
            <span className="block text-[12px] text-muted-foreground">{f.content ? `约 ${f.content.length} 字` : "未提取到文字"}</span>
          </span>
          <button onClick={() => remove(f.id)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground/40 transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除资料">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function RenameRow({ project, onRename }: { project: Project; onRename: (id: string, name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(project.name)
  useEffect(() => { setDraft(project.name) }, [project.name])

  function save() { const n = draft.trim(); if (n) onRename(project.id, n); setEditing(false) }

  if (editing) {
    return (
      <div className="flex gap-2 py-1">
        <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); save() } if (e.key === "Escape") { setDraft(project.name); setEditing(false) } }}
          className="flex-1 rounded-xl border border-sidebar-border bg-background/50 px-3 py-1.5 text-[13px] outline-none focus:border-sidebar-primary/50" />
        <button onClick={save} className="rounded-xl bg-sidebar-primary px-3 text-[13px] text-sidebar-primary-foreground">保存</button>
      </div>
    )
  }
  return (
    <button onClick={() => setEditing(true)} className="flex w-full items-center justify-center gap-1.5 rounded-2xl py-2.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
      <Pencil className="size-3.5" />重命名项目
    </button>
  )
}

// ── 会话行：标题 + 置顶/收藏角标 + "更多"按钮；改名时就地变输入框 ──
function ConversationRow({ c, isActive, renaming, onSelect, onOpenMenu, onCommitRename, onCancelRename }: {
  c: Conversation
  isActive: boolean
  renaming: boolean
  onSelect: (id: string) => void
  onOpenMenu: (id: string, anchor: Anchor) => void
  onCommitRename: (id: string, title: string) => void
  onCancelRename: () => void
}) {
  const [val, setVal] = useState(c.title)
  useEffect(() => { setVal(c.title) }, [c.title])

  if (renaming) {
    const commit = () => { const t = val.trim(); if (t) onCommitRename(c.id, t); else onCancelRename() }
    return (
      <div className="px-2 py-1">
        <input
          autoFocus value={val} onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit() } if (e.key === "Escape") { setVal(c.title); onCancelRename() } }}
          onBlur={commit}
          className="w-full rounded-xl border border-sidebar-border bg-background/50 px-3 py-2 text-sm outline-none focus:border-sidebar-primary/50"
        />
      </div>
    )
  }

  return (
    <div className="group relative">
      <button
        onClick={() => onSelect(c.id)}
        className={cn("block w-full rounded-2xl px-4 py-3 pr-9 text-left transition-all duration-150 active:scale-[0.985]", isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5">
            {c.pinned && <Pin className="size-3 shrink-0 rotate-45 fill-current text-sidebar-primary/70" />}
            {c.projectId && <Folder className="size-3 shrink-0 text-sidebar-primary/60" />}
            <span className={cn("truncate text-[14px] font-medium leading-snug", isActive ? "text-sidebar-primary" : "text-sidebar-foreground")}>{c.title}</span>
            {c.starred && <Star className="size-3 shrink-0 fill-current text-sidebar-primary/70" />}
          </span>
          <span className="shrink-0 text-[11px] tracking-wider text-muted-foreground">{c.date}</span>
        </div>
        {c.excerpt && <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{c.excerpt}</p>}
      </button>
      <button
        onClick={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onOpenMenu(c.id, { top: r.top, bottom: r.bottom, right: r.right }) }}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground/50 transition-all hover:bg-sidebar-accent hover:text-foreground active:scale-90"
        aria-label="更多"
      >
        <MoreHorizontal className="size-4" />
      </button>
    </div>
  )
}

function ActionRow({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors active:scale-[0.98]", danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-sidebar-accent/60")}>
      <span className={cn("shrink-0", danger ? "text-destructive" : "text-muted-foreground")}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

// 会话"更多菜单"弹层：锚定在 ⋯ 旁，portal 到 body，淡入+轻微缩放（自然手感，且不被裁切）
function ConvMenu({ conv, anchor, projects, picker, onPicker, onClose, onToggleStar, onTogglePin, onStartRename, onAddToProject, onDelete }: {
  conv: Conversation
  anchor: Anchor
  projects: Project[]
  picker: boolean
  onPicker: (v: boolean) => void
  onClose: () => void
  onToggleStar: () => void
  onTogglePin: () => void
  onStartRename: () => void
  onAddToProject: (projectId: string | null) => void
  onDelete: () => void
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r) }, [])
  if (typeof document === "undefined") return null

  const vw = window.innerWidth, vh = window.innerHeight
  const W = 172
  const estH = picker ? 300 : 212
  const openUp = anchor.bottom + estH > vh - 12
  const right = Math.max(10, vw - anchor.right)
  const pos: React.CSSProperties = {
    position: "fixed", right, width: W,
    transformOrigin: openUp ? "bottom right" : "top right",
    ...(openUp ? { bottom: vh - anchor.top + 6 } : { top: anchor.bottom + 6 }),
  }

  return createPortal(
    <div className="fixed inset-0 z-[80]" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={pos}
        className={cn(
          "overflow-hidden rounded-2xl border border-sidebar-border bg-card p-1 shadow-xl transition-all duration-150 ease-out",
          shown ? "scale-100 opacity-100" : "scale-95 opacity-0",
        )}
      >
        {!picker ? (
          <>
            <ActionRow icon={<Star className={cn("size-4", conv.starred && "fill-current text-sidebar-primary")} />} label={conv.starred ? "取消收藏" : "收藏"} onClick={onToggleStar} />
            <ActionRow icon={<Pencil className="size-4" />} label="编辑标题" onClick={onStartRename} />
            <ActionRow icon={<FolderPlus className="size-4" />} label="添加进项目" onClick={() => onPicker(true)} />
            <ActionRow icon={<Pin className="size-4" />} label={conv.pinned ? "取消置顶" : "置顶"} onClick={onTogglePin} />
            <div className="my-1 border-t border-sidebar-border/60" />
            <ActionRow icon={<Trash2 className="size-4" />} label="删除" danger onClick={onDelete} />
          </>
        ) : (
          <>
            <button onClick={() => onPicker(false)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent/60">
              <ChevronLeft className="size-4" />添加进项目
            </button>
            <div className="max-h-[44vh] overflow-y-auto">
              {conv.projectId && (
                <ActionRow icon={<X className="size-4" />} label="移出当前项目" onClick={() => onAddToProject(null)} />
              )}
              {projects.filter(p => p.id !== conv.projectId).map(p => (
                <ActionRow key={p.id} icon={<Folder className="size-4" />} label={p.name} onClick={() => onAddToProject(p.id)} />
              ))}
              {projects.filter(p => p.id !== conv.projectId).length === 0 && !conv.projectId && (
                <p className="px-3 py-4 text-center text-[12px] italic text-muted-foreground/70">还没有项目</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

// ── 基础设定（对话偏好，Claude.ai 风格的纯文本框 + 字数 + 保存/取消）──
const BASICS_MAX = 2000
function BasicsScreen() {
  const [value, setValue] = useState('')
  const [saved, setSaved] = useState('')   // 最近一次已保存的值，供"取消"回退 + 脏检查
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  useEffect(() => {
    fetchCustomSystemPrompt().then(v => { setValue(v); setSaved(v); setLoading(false) })
  }, [])

  const dirty = value !== saved

  async function save() {
    setSaving(true)
    await saveCustomSystemPrompt(value)
    setSaved(value)
    setSaving(false)
    setJustSaved(true)
    setTimeout(() => setJustSaved(false), 2000)
  }

  if (loading) return <div className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</div>

  return (
    <div className="space-y-4 px-4">
      <div>
        <p className="text-[13px] font-medium text-foreground">对话偏好</p>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          告诉它你希望被如何回应，这些偏好会在每段对话里默默生效。
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-sidebar-border bg-card transition-colors focus-within:border-sidebar-primary/55">
        <textarea
          value={value}
          maxLength={BASICS_MAX}
          onChange={e => setValue(e.target.value)}
          placeholder="比如：「回复尽量简短」「优先中文资料」「多用表格和列表」「语气随和一点」"
          className="block min-h-[180px] w-full resize-none bg-transparent px-4 py-3.5 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/45"
        />
        <div className="flex justify-end px-4 pb-2.5">
          <span className={cn("text-[11px] tabular-nums", value.length > BASICS_MAX * 0.9 ? "text-destructive/80" : "text-muted-foreground/55")}>
            {value.length} / {BASICS_MAX}
          </span>
        </div>
      </div>

      <div className="flex gap-2.5">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-sidebar-primary py-2.5 text-[13px] font-medium text-sidebar-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {justSaved ? <><Check className="size-3.5" />已保存</> : saving ? '保存中…' : '保存'}
        </button>
        <button
          onClick={() => setValue(saved)}
          disabled={!dirty || saving}
          className="flex flex-1 items-center justify-center rounded-xl border border-sidebar-border bg-sidebar-accent/40 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent/70 hover:text-foreground disabled:opacity-40"
        >
          取消
        </button>
      </div>
    </div>
  )
}

// ── 使用额度展示 ──
function QuotaScreen() {
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      const q = await fetchQuota()
      setQuota(q)
      setLoading(false)
    })()
  }, [])

  function fmtNum(n: number) { return n.toLocaleString() }
  function pct(n: number, max: number) { return Math.min(100, (n / max) * 100) }
  function fmtRemaining(windowStart: string, windowMs: number): string {
    const rem = Math.max(0, windowMs - (Date.now() - new Date(windowStart).getTime()))
    const h = Math.floor(rem / 3600000)
    const m = Math.floor((rem % 3600000) / 60000)
    if (h > 24) return `${Math.floor(h / 24)}天 ${h % 24}h 后重置`
    if (h > 0) return `${h}h ${m}m 后重置`
    return `${m}m 后重置`
  }

  if (loading) return <div className="px-4 py-8 text-center text-sm text-muted-foreground">加载中…</div>

  const t5h = (quota?.tokens5h ?? 0)
  const t7d = (quota?.tokens7d ?? 0)
  const max5h = 500_000
  const max7d = 1_000_000
  const w5h = quota?.window5hStart ?? new Date().toISOString()
  const w7d = quota?.window7dStart ?? new Date().toISOString()

  const plans = [
    { tokens: '100 万', price: 18, popular: false },
    { tokens: '300 万', price: 48, popular: true },
    { tokens: '500 万', price: 78, popular: false },
  ]

  return (
    <div className="space-y-4 px-4">

      <div className="space-y-2.5 rounded-2xl bg-sidebar-accent/55 p-4 border border-sidebar-border">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-foreground">5 小时用量</span>
          <span className="text-[11px] text-muted-foreground">{fmtRemaining(w5h, 5 * 3600 * 1000)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent/70">
          <div className="h-full rounded-full bg-sidebar-primary transition-all" style={{ width: `${pct(t5h, max5h)}%` }} />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{fmtNum(t5h)}</span>
          <span>{fmtNum(max5h)}</span>
        </div>
      </div>

      <div className="space-y-2.5 rounded-2xl bg-sidebar-accent/55 p-4 border border-sidebar-border">
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-foreground">7 天用量</span>
          <span className="text-[11px] text-muted-foreground">{fmtRemaining(w7d, 7 * 86400 * 1000)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sidebar-accent/70">
          <div className="h-full rounded-full bg-sidebar-primary transition-all" style={{ width: `${pct(t7d, max7d)}%` }} />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{fmtNum(t7d)}</span>
          <span>{fmtNum(max7d)}</span>
        </div>
      </div>

      {/* 计费倍率简介 */}
      <div className="rounded-2xl bg-sidebar-accent/55 px-4 py-3 border border-sidebar-border">
        <div className="text-[12px] font-medium text-foreground">按模型计费倍率</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>绝句 <span className="font-medium text-foreground">×0.8</span></span>
          <span className="text-sidebar-border">·</span>
          <span>正构 <span className="font-medium text-foreground">×1</span></span>
          <span className="text-sidebar-border">·</span>
          <span>鸿篇／深研 <span className="font-medium text-foreground">×3</span></span>
        </div>
      </div>

      {/* 购买额度 */}
      <div className="space-y-2.5 pt-1">
        <div className="text-[13px] font-medium text-foreground">购买额度</div>
        <div className="grid grid-cols-2 gap-2.5">
          {plans.map((p) => (
            <button
              key={p.tokens}
              type="button"
              className={`relative flex flex-col items-center gap-1 rounded-2xl px-3 py-4 border transition-transform active:scale-[0.98] ${p.popular ? 'bg-sidebar-primary/10 border-sidebar-primary/40' : 'bg-sidebar-accent/55 border-sidebar-border'}`}
            >
              {p.popular && (
                <span className="absolute -top-2 rounded-full bg-sidebar-primary px-2 py-0.5 text-[10px] font-medium text-sidebar-primary-foreground">最划算</span>
              )}
              <span className="text-[15px] font-semibold text-foreground">{p.tokens}</span>
              <span className="text-[11px] text-muted-foreground">token 额度</span>
              <span className="mt-1 text-[15px] font-semibold text-sidebar-primary">¥{p.price}</span>
            </button>
          ))}
          <button
            type="button"
            className="flex flex-col items-center justify-center gap-1 rounded-2xl px-3 py-4 border border-sidebar-border bg-sidebar-accent/55 transition-transform active:scale-[0.98]"
          >
            <span className="text-[15px] font-semibold text-foreground">自定义</span>
            <span className="text-[11px] text-muted-foreground">按需购买</span>
          </button>
        </div>
        <p className="px-1 text-[11px] text-muted-foreground">购买功能即将开放</p>
      </div>
    </div>
  )
}
