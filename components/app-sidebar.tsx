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
  FileText, Loader2, FolderPlus,
  MoreHorizontal, Star, Pin, Lock,
  Code2,
} from "lucide-react"
import { fetchQuota, type QuotaSnapshot } from "@/lib/db"

// 二级页面：除根视图（侧栏主体）外的可滑入全屏页面。设置＝真正的二级滑入页（带返回头）。
type Screen = "settings" | "projects" | "artifacts" | "project-detail"

// 层级 z：设置/项目/作品为一级(20)，项目详情为二级(30)，均高于根面板(10)。
const Z: Record<Screen, number> = {
  settings: 20, projects: 20, artifacts: 20, "project-detail": 30,
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
  onLoadProjectMemories: (projectId: string) => Promise<Memory[]>
  onAddProjectMemory: (projectId: string, content: string) => Promise<Memory | null>
  onEditProjectMemory: (id: string, content: string) => void
  onDeleteProjectMemory: (id: string) => void
  onToggleStar: (id: string) => void
  onTogglePin: (id: string) => void
  onRenameConversation: (id: string, title: string) => void
  onAddToProject: (id: string, projectId: string | null) => void
  userEmail: string
  onLogout: () => void
  onOpenCode: () => void
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
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<Anchor | null>(null) // 项目详情 ⋯ 菜单位置
  const [projectRenaming, setProjectRenaming] = useState(false)           // 项目详情顶部就地改名

  // 抽屉收起后复位到根视图
  useEffect(() => { if (!visible) { setStack([]); setUserMenuOpen(false); setSelectedProjectId(null); setActionConvId(null); setRenamingId(null); setProjectMenuAnchor(null); setProjectRenaming(false) } }, [visible])

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
        <NavRow icon={<Code2 className="size-4" />} label="代码" onClick={() => { setStack([]); setUserMenuOpen(false); props.onOpenCode() }} />
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
        <SettingsScreen
          memories={props.memories}
          memoryEnabled={props.memoryEnabled}
          onMemoryEnabledChange={props.onMemoryEnabledChange}
          onMemoryAdd={props.onMemoryAdd}
          onMemoryEdit={props.onMemoryEdit}
          onMemoryDelete={props.onMemoryDelete}
        />
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

      <ScreenPanel
        style={screenStyle("project-detail")}
        onBack={pop}
        title={
          projectRenaming && selectedProject ? (
            <ProjectTitleEditor
              name={selectedProject.name}
              onSave={(n) => { props.onProjectRename(selectedProject.id, n); setProjectRenaming(false) }}
              onCancel={() => setProjectRenaming(false)}
            />
          ) : (selectedProject?.name ?? "项目")
        }
        action={selectedProject && !projectRenaming ? (
          <button
            aria-label="项目操作"
            onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setProjectMenuAnchor({ top: r.top, bottom: r.bottom, right: r.right }) }}
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            <MoreHorizontal className="size-5" />
          </button>
        ) : undefined}
      >
        {selectedProject && (
          <ProjectDetailScreen
            key={selectedProject.id}
            project={selectedProject}
            conversations={conversations}
            onOpenChat={handleSelect}
            onNewChat={props.onNewInProject}
            onInstructions={props.onProjectInstructions}
            onLoadFiles={props.onLoadProjectFiles}
            onAddFile={props.onAddProjectFile}
            onDeleteFile={props.onDeleteProjectFile}
            onLoadProjectMemories={props.onLoadProjectMemories}
            onAddProjectMemory={(content) => props.onAddProjectMemory(selectedProject.id, content)}
            onEditProjectMemory={props.onEditProjectMemory}
            onDeleteProjectMemory={props.onDeleteProjectMemory}
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

  // 项目「更多菜单」：锚定在项目详情顶部 ⋯ 旁，重命名 / 删除
  const projectMenu = selectedProject && projectMenuAnchor && (
    <ProjectMenu
      anchor={projectMenuAnchor}
      onClose={() => setProjectMenuAnchor(null)}
      onRename={() => { setProjectRenaming(true); setProjectMenuAnchor(null) }}
      onDelete={() => { props.onProjectDelete(selectedProject.id); setProjectMenuAnchor(null); pop() }}
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
        {projectMenu}
      </>
    )
  }

  // 桌面：常驻侧栏，二级页面在 20rem 容器内滑动
  return (
    <aside className="relative flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      {rootContent}
      {screens}
      {convMenu}
      {projectMenu}
    </aside>
  )
}

// ── 二级页面外壳：统一返回头（可带右侧操作）+ 滑动动画 ──
function ScreenPanel({ style, title, onBack, action, children }: {
  style: React.CSSProperties
  title: React.ReactNode
  onBack: () => void
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 flex flex-col bg-sidebar transition-transform duration-[360ms] ease-[cubic-bezier(0.32,0.72,0,1)]" style={style}>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button onClick={onBack} className="-ml-1 shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="返回">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          {typeof title === "string"
            ? <h3 className="truncate text-[17px] font-semibold tracking-tight">{title}</h3>
            : title}
        </div>
        {action}
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

        {/* 统一记忆卡片：空态/列表/添加表单都在一个有边界的容器内 */}
        <div className="rounded-2xl border border-sidebar-border bg-sidebar-accent/30 overflow-hidden">
          {/* 滚动区域 */}
          <div className="max-h-[340px] overflow-y-auto">
            {memories.length === 0 && !adding && (
              <p className="px-4 py-8 text-center text-[13px] italic text-muted-foreground/60">还没有记忆</p>
            )}
            {memories.length > 0 && (
              <div className="space-y-0 divide-y divide-sidebar-border/40">
                {memories.map(m => (
                  <div key={m.id} className="px-3 py-2.5">
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
              </div>
            )}
            {adding && (
              <div className="px-3 py-2.5 space-y-2 border-t border-sidebar-border/40">
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
            )}
          </div>
          {/* 添加按钮固定在卡片底部 */}
          {!adding && (
            <button onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 border-t border-sidebar-border/40 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-foreground">
              <Plus className="size-4" />添加记忆
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

// ── 项目详情＝工作台（单页纵向滚动）：起新对谈 + 对谈列表 + 记忆/指令/资料分组 ──
// 重命名、删除收进顶部 ⋯ 菜单（由 ScreenPanel 的 action 触发），此处不再出现管理型大按钮。
function ProjectDetailScreen({
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
  onOpenConvMenu: (id: string, anchor: Anchor) => void
  onRenameConversation: (id: string, title: string) => void
  onStopRename: () => void
}) {
  const chats = sortConvs(conversations.filter(c => c.projectId === project.id && !c.draft))

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
        <p className="mb-2 px-1 text-[11px] tracking-[0.18em] text-muted-foreground/70">本项目对谈{chats.length > 0 ? ` · ${chats.length}` : ""}</p>
        {chats.length === 0 ? (
          <p className="rounded-2xl bg-sidebar-accent/25 px-4 py-6 text-center text-[13px] italic text-muted-foreground/70">还没有对谈，从上方开始第一段</p>
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
function ProjectTitleEditor({ name, onSave, onCancel }: { name: string; onSave: (n: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(name)
  return (
    <input
      autoFocus
      value={v}
      onChange={e => setV(e.target.value)}
      onKeyDown={e => {
        if (e.key === "Enter") { e.preventDefault(); const n = v.trim(); n ? onSave(n) : onCancel() }
        if (e.key === "Escape") onCancel()
      }}
      onBlur={() => { const n = v.trim(); n && n !== name ? onSave(n) : onCancel() }}
      className="w-full rounded-lg border border-sidebar-border bg-background/50 px-2.5 py-1 text-[16px] font-semibold outline-none focus:border-sidebar-primary/50"
    />
  )
}

// 项目级记忆：独立于全局记忆，仅在该项目对话时注入上下文
function ProjectMemorySection({ projectId, onLoad, onAdd, onEdit, onDelete }: {
  projectId: string
  onLoad: (pid: string) => Promise<Memory[]>
  onAdd: (content: string) => Promise<Memory | null>
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
}) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [newValue, setNewValue] = useState("")
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    onLoad(projectId).then(mems => { if (!cancelled) { setMemories(mems); setLoading(false) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  function startEdit(m: Memory) { setEditingId(m.id); setEditValue(m.content) }
  function saveEdit() {
    if (!editingId || !editValue.trim()) return
    onEdit(editingId, editValue.trim())
    setMemories(prev => prev.map(m => m.id === editingId ? { ...m, content: editValue.trim() } : m))
    setEditingId(null)
  }
  async function addMemory() {
    if (!newValue.trim()) return
    const mem = await onAdd(newValue.trim())
    if (mem) setMemories(prev => [...prev, mem])
    setNewValue(""); setAdding(false)
  }
  function removeMemory(id: string) {
    setMemories(prev => prev.filter(m => m.id !== id))
    onDelete(id)
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">记忆</span>
        <span className="flex items-center gap-1 rounded-full bg-sidebar-accent/60 px-2 py-0.5 text-[11px] text-muted-foreground">
          <Lock className="size-3" />仅你可见
        </span>
      </div>
      <p className="mt-1 mb-2.5 text-[12px] leading-relaxed text-muted-foreground">本项目中积累的重要信息，对话时自动注入，与全局记忆分隔。</p>

      {loading ? (
        <p className="text-[12px] italic text-muted-foreground/60">载入中……</p>
      ) : (
        <div className="space-y-1.5">
          {memories.length === 0 && !adding && (
            <p className="text-center text-[12px] italic text-muted-foreground/60 py-1">还没有记忆</p>
          )}

          {memories.length > 0 && (
            <div className="max-h-[200px] overflow-y-auto space-y-1.5 pr-0.5">
              {memories.map(m => (
                <div key={m.id} className="rounded-xl bg-sidebar-accent/30 px-3 py-2">
                  {editingId === m.id ? (
                    <div className="space-y-1.5">
                      <textarea
                        autoFocus
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit() } if (e.key === "Escape") setEditingId(null) }}
                        className="w-full resize-none rounded-xl bg-sidebar-accent/60 border border-sidebar-accent/70 px-2 py-1.5 text-[12px] outline-none focus:bg-sidebar-accent/80"
                        rows={2}
                      />
                      <div className="flex gap-1.5">
                        <button onClick={saveEdit} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1 text-[12px] text-sidebar-primary-foreground"><Check className="size-3" />保存</button>
                        <button onClick={() => setEditingId(null)} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/60 py-1 text-[12px] text-muted-foreground"><X className="size-3" />取消</button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-2">
                      <p className="flex-1 text-[12px] leading-relaxed text-foreground/85">{m.content}</p>
                      <div className="flex shrink-0 gap-0.5">
                        <button onClick={() => startEdit(m)} className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="编辑"><Pencil className="size-3" /></button>
                        <button onClick={() => removeMemory(m.id)} className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除"><Trash2 className="size-3" /></button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {adding ? (
            <div className="space-y-1.5 rounded-xl bg-sidebar-accent/30 px-3 py-2">
              <textarea
                autoFocus
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMemory() } if (e.key === "Escape") setAdding(false) }}
                placeholder="输入要记住的内容……"
                className="w-full resize-none rounded-xl bg-sidebar-accent/60 border border-sidebar-accent/70 px-2 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/40 focus:bg-sidebar-accent/80"
                rows={2}
              />
              <div className="flex gap-1.5">
                <button onClick={addMemory} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1 text-[12px] text-sidebar-primary-foreground"><Check className="size-3" />添加</button>
                <button onClick={() => setAdding(false)} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/60 py-1 text-[12px] text-muted-foreground"><X className="size-3" />取消</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1 py-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground">
              <Plus className="size-3.5" />手动添加记忆
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// 项目指令段：点开就地编辑
function ProjectInstructionsSection({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  const has = value.trim().length > 0

  if (editing) {
    return (
      <div className="space-y-2 p-4">
        <span className="text-sm font-medium text-foreground">项目指令</span>
        <textarea
          autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          placeholder="例如：你是我的英语学习教练，回答时多结合本项目里的资料……"
          className="w-full resize-none rounded-xl border border-sidebar-border bg-background/40 px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/45 focus:border-sidebar-primary/50"
          rows={4}
        />
        <div className="flex gap-2">
          <button onClick={() => { onSave(draft.trim()); setEditing(false) }} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[13px] text-sidebar-primary-foreground"><Check className="size-3.5" />保存</button>
          <button onClick={() => { setDraft(value); setEditing(false) }} className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-sidebar-border py-1.5 text-[13px] text-muted-foreground"><X className="size-3.5" />取消</button>
        </div>
      </div>
    )
  }

  return (
    <button onClick={() => setEditing(true)} className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-sidebar-accent/30">
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">项目指令</span>
          <Pencil className="size-3.5 shrink-0 text-muted-foreground/60" />
        </span>
        <span className={cn("mt-1 block text-[12px] leading-relaxed", has ? "text-muted-foreground line-clamp-3" : "text-muted-foreground/70")}>
          {has ? value : "添加指令，定制小克在本项目中的回答与人设。"}
        </span>
      </span>
    </button>
  )
}

// 资料段：列表 + 右上角「+」上传
function ProjectFilesSection({ project, onLoadFiles, onAddFile, onDeleteFile }: {
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
    <div className="p-4">
      <input ref={inputRef} type="file" multiple
        accept=".pdf,.txt,.md,.markdown,.csv,.json,.log,.xml,.yaml,.yml,.html,.htm,text/*"
        className="hidden" onChange={handlePick} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">资料{files.length > 0 ? ` · ${files.length}` : ""}</span>
        <button onClick={() => inputRef.current?.click()} disabled={uploading} className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50" aria-label="添加资料">
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </button>
      </div>
      {err && <p className="mt-1 text-[12px] text-destructive">{err}</p>}

      {loading ? (
        <p className="mt-2 text-[13px] italic text-muted-foreground/60">载入中……</p>
      ) : files.length === 0 ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">上传 PDF 或文本，本项目的对谈会以它为参考。</p>
      ) : (
        <div className="mt-2.5 space-y-1.5">
          {files.map(f => (
            <div key={f.id} className="group flex items-center gap-3 rounded-xl bg-sidebar-accent/30 px-3 py-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary/10 text-sidebar-primary"><FileText className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">{f.name}</span>
                <span className="block text-[11px] text-muted-foreground">{f.content ? `约 ${f.content.length} 字` : "未提取到文字"}</span>
              </span>
              <button onClick={() => remove(f.id)} className="shrink-0 rounded-full p-1.5 text-muted-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除资料">
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
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
    <button onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors active:scale-[0.98]", danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-sidebar-accent/60")}>
      <span className={cn("shrink-0", danger ? "text-destructive" : "text-muted-foreground")}>{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}

// ── 共享弹层外壳：右锚定在触发点旁，portal 到 body，淡入+轻微缩放 ──
// 宽度贴合内容（w-max）并夹在 192–272px 之间，避免半屏宽的大片留白；竖向超界时朝上展开。
function PopoverShell({ anchor, estH, onClose, children }: {
  anchor: Anchor
  estH: number
  onClose: () => void
  children: React.ReactNode
}) {
  const [shown, setShown] = useState(false)
  useEffect(() => { const r = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(r) }, [])
  if (typeof document === "undefined") return null

  const vw = window.innerWidth, vh = window.innerHeight
  const openUp = anchor.bottom + estH > vh - 12
  const right = Math.max(10, vw - anchor.right)
  const pos: React.CSSProperties = {
    position: "fixed", right,
    transformOrigin: openUp ? "bottom right" : "top right",
    ...(openUp ? { bottom: vh - anchor.top + 6 } : { top: anchor.bottom + 6 }),
  }

  return createPortal(
    <div className="fixed inset-0 z-[80]" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        style={pos}
        className={cn(
          "w-max min-w-[148px] max-w-[192px] overflow-hidden rounded-2xl border border-sidebar-border bg-card p-0.5 shadow-xl transition-all duration-150 ease-out",
          shown ? "scale-100 opacity-100" : "scale-95 opacity-0",
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

// 会话"更多菜单"：收藏 / 编辑标题 / 加入项目 / 置顶 / 删除
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
  return (
    <PopoverShell anchor={anchor} estH={picker ? 320 : 256} onClose={onClose}>
      {!picker ? (
        <>
          <ActionRow icon={<Star className={cn("size-4", conv.starred && "fill-current text-sidebar-primary")} />} label={conv.starred ? "取消收藏" : "收藏"} onClick={onToggleStar} />
          <ActionRow icon={<Pencil className="size-4" />} label="编辑标题" onClick={onStartRename} />
          <ActionRow icon={<FolderPlus className="size-4" />} label="加入项目" onClick={() => onPicker(true)} />
          <ActionRow icon={<Pin className="size-4" />} label={conv.pinned ? "取消置顶" : "置顶"} onClick={onTogglePin} />
          <div className="my-1 border-t border-sidebar-border/60" />
          <ActionRow icon={<Trash2 className="size-4" />} label="删除" danger onClick={onDelete} />
        </>
      ) : (
        <>
          <button onClick={() => onPicker(false)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/60">
            <ChevronLeft className="size-4" />加入项目
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
    </PopoverShell>
  )
}

// 项目"更多菜单"：重命名 / 删除（删除二次确认，避免误删整个项目）
function ProjectMenu({ anchor, onClose, onRename, onDelete }: {
  anchor: Anchor
  onClose: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  return (
    <PopoverShell anchor={anchor} estH={128} onClose={onClose}>
      <ActionRow icon={<Pencil className="size-4" />} label="重命名项目" onClick={onRename} />
      <div className="my-1 border-t border-sidebar-border/60" />
      <ActionRow
        icon={<Trash2 className="size-4" />}
        label={confirm ? "确认删除此项目" : "删除此项目"}
        danger
        onClick={() => { if (confirm) onDelete(); else setConfirm(true) }}
      />
    </PopoverShell>
  )
}

// ── 使用额度展示 ──
function QuotaScreen() {
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [codeInput, setCodeInput] = useState('')
  const [codeLoading, setCodeLoading] = useState(false)
  const [codeMsg, setCodeMsg] = useState('')

  useEffect(() => {
    (async () => {
      const q = await fetchQuota()
      setQuota(q)
      setLoading(false)
    })()

    const timer = setInterval(async () => {
      const q = await fetchQuota()
      setQuota(q)
    }, 10_000)

    return () => { clearInterval(timer) }
  }, [])

  async function handleRedeemCode() {
    if (!codeInput.trim()) return
    setCodeLoading(true)
    setCodeMsg('')
    try {
      const res = await fetch('/api/redeem-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeInput }),
      })
      const data = await res.json()
      if (res.ok) {
        setCodeMsg(`✓ 兑换成功，获得 ${(data.tokensAdded / 1_000_000).toFixed(0)} 百万额度`)
        setCodeInput('')
        const q = await fetchQuota()
        setQuota(q)
      } else {
        setCodeMsg(data.error || '兑换失败')
      }
    } catch {
      setCodeMsg('网络错误')
    } finally {
      setCodeLoading(false)
    }
  }


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
  const max7d = 10_000_000
  const w5h = quota?.window5hStart ?? new Date().toISOString()
  const w7d = quota?.window7dStart ?? new Date().toISOString()

  const plans = [
    { tokens: '100 万', price: 18, popular: false },
    { tokens: '300 万', price: 48, popular: true },
    { tokens: '500 万', price: 78, popular: false },
  ]

  return (
    <div className="space-y-4 px-4">

      {/* 账户余额 */}
      <div className="rounded-2xl bg-sidebar-primary/15 px-4 py-3 border border-sidebar-primary/30">
        <div className="text-[12px] text-muted-foreground">账户余额</div>
        <div className="mt-1.5 text-[22px] font-semibold text-foreground">{fmtNum(quota?.balance ?? 0)}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">token（不受时间窗口限制）</div>
      </div>

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
          <span>快速 <span className="font-medium text-foreground">×0.8</span></span>
          <span className="text-sidebar-border">·</span>
          <span>均衡 <span className="font-medium text-foreground">×1</span></span>
          <span className="text-sidebar-border">·</span>
          <span>深度／深研 <span className="font-medium text-foreground">×3</span></span>
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

      {/* 邀请码兑换 */}
      <div className="space-y-2">
        <div className="text-[13px] font-medium text-foreground">邀请码兑换</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={codeInput}
            onChange={e => setCodeInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRedeemCode() }}
            placeholder="输入邀请码"
            className="flex-1 rounded-xl bg-sidebar-accent/50 px-3 py-2 text-sm outline-none focus:bg-sidebar-accent/75 placeholder:text-muted-foreground/50"
            disabled={codeLoading}
          />
          <button
            onClick={handleRedeemCode}
            disabled={codeLoading || !codeInput.trim()}
            className="rounded-xl bg-sidebar-primary px-4 py-2 text-sm text-sidebar-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {codeLoading ? '兑换中…' : '兑换'}
          </button>
        </div>
        {codeMsg && (
          <p className={cn('text-[12px]', codeMsg.startsWith('✓') ? 'text-green-600' : 'text-destructive')}>
            {codeMsg}
          </p>
        )}
      </div>

    </div>
  )
}

// ── 设置（二级全屏页内容）：两个板块 —— 「基础与记忆」｜「使用额度」──
// 装在 ScreenPanel 里（顶部统一返回头由外壳提供），标签切换两块内容，不再逐层滑入碎片子页。
function SettingsScreen({ memories, memoryEnabled, onMemoryEnabledChange, onMemoryAdd, onMemoryEdit, onMemoryDelete }: {
  memories: Memory[]
  memoryEnabled: boolean
  onMemoryEnabledChange: (v: boolean) => void
  onMemoryAdd: (content: string) => void
  onMemoryEdit: (id: string, content: string) => void
  onMemoryDelete: (id: string) => void
}) {
  const [tab, setTab] = useState<'general' | 'quota'>('general')

  const pill = (active: boolean) =>
    cn("rounded-full px-3.5 py-1.5 text-[13px] transition-colors", active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:text-foreground")

  return (
    <div>
      <div className="mb-1 flex gap-1.5 px-4">
        <button onClick={() => setTab('general')} className={pill(tab === 'general')}>记忆</button>
        <button onClick={() => setTab('quota')} className={pill(tab === 'quota')}>使用额度</button>
      </div>

      {tab === 'general' ? (
        <div className="pt-2">
          <MemoryScreen
            memories={memories}
            enabled={memoryEnabled}
            onEnabledChange={onMemoryEnabledChange}
            onAdd={onMemoryAdd}
            onEdit={onMemoryEdit}
            onDelete={onMemoryDelete}
          />
        </div>
      ) : (
        <div className="pt-2">
          <QuotaScreen />
        </div>
      )}
    </div>
  )
}
