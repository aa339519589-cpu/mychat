"use client"

import { useEffect, useState } from "react"
import type { Conversation } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import type { Project, ProjectFile } from "@/lib/project-data"
import { cn } from "@/lib/utils"
import {
  Feather, Plus, ChevronRight, LogOut, Settings, Folder, Shapes,
  MoreHorizontal, PanelLeft, Code2,
} from "lucide-react"
import { ConversationMenu } from "@/components/conversation-menu"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { ConversationRow, NavRow, ProjectMenu, ScreenPanel } from "@/components/sidebar/primitives"
import { ProjectDetailScreen, ProjectsScreen, ProjectTitleEditor } from "@/components/sidebar/projects"
import { SettingsScreen } from "@/components/sidebar/settings"
import { sortConversations, type SidebarAnchor } from "@/components/sidebar/shared"

// 二级页面：除根视图（侧栏主体）外的可滑入全屏页面。设置＝真正的二级滑入页（带返回头）。
type Screen = "settings" | "projects" | "project-detail"

// 层级 z：设置/项目/作品为一级(20)，项目详情为二级(30)，均高于根面板(10)。
const Z: Record<Screen, number> = {
  settings: 20, projects: 20, "project-detail": 30,
}

export type AppSidebarProps = {
  conversation: {
    items: Conversation[]; activeId: string
    select: (id: string) => void; create: () => void; delete: (id: string) => void
    toggleStar: (id: string) => void; togglePin: (id: string) => void
    rename: (id: string, title: string) => void; move: (id: string, projectId: string | null) => void
  }
  memory: {
    items: Memory[]; enabled: boolean; setEnabled: (value: boolean) => void
    add: (content: string) => void; edit: (id: string, content: string) => void; delete: (id: string) => void
  }
  project: {
    items: Project[]; create: (name: string) => Promise<Project | null>
    rename: (id: string, name: string) => void; setInstructions: (id: string, instructions: string) => void
    delete: (id: string) => void; createConversation: (projectId: string) => void
    loadFiles: (projectId: string) => Promise<ProjectFile[]>; addFile: (projectId: string, file: File) => Promise<ProjectFile | null>
    deleteFile: (fileId: string) => void; loadMemories: (projectId: string) => Promise<Memory[]>
    addMemory: (projectId: string, content: string) => Promise<Memory | null>
    editMemory: (id: string, content: string) => void; deleteMemory: (id: string) => void
  }
  model: {
    endpoints: ModelEndpointSummary[]; activeId: string | null; select: (id: string) => void
    created: (endpoint: ModelEndpointSummary) => void; updated: (endpoint: ModelEndpointSummary) => void
    deleted: (id: string) => void
  }
  session: { email: string; logout: () => void; openCode: () => void; openArtifacts: () => void }
}

// 单一响应式实例：移动端根面板占 82vw，桌面端常驻于 20rem 容器。
export function AppSidebar({
  visible = false, onClose, ...props
}: AppSidebarProps & { visible?: boolean; onClose?: () => void }) {
  const { items: conversations, activeId } = props.conversation
  const [stack, setStack] = useState<Screen[]>([])
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [actionConvId, setActionConvId] = useState<string | null>(null)   // 打开"更多菜单"的会话
  const [actionAnchor, setActionAnchor] = useState<SidebarAnchor | null>(null)   // ⋯ 按钮的位置
  const [renamingId, setRenamingId] = useState<string | null>(null)       // 正在改名的会话
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<SidebarAnchor | null>(null) // 项目详情 ⋯ 菜单位置
  const [projectRenaming, setProjectRenaming] = useState(false)           // 项目详情顶部就地改名

  // 抽屉收起或从桌面切到移动端时复位，避免把桌面二级页留在关闭的移动抽屉上。
  useEffect(() => {
    const reset = () => {
      setStack([])
      setUserMenuOpen(false)
      setSelectedProjectId(null)
      setActionConvId(null)
      setRenamingId(null)
      setProjectMenuAnchor(null)
      setProjectRenaming(false)
    }
    if (!visible) reset()
    const media = window.matchMedia("(max-width: 767px)")
    const onViewportChange = (event: MediaQueryListEvent) => { if (event.matches && !visible) reset() }
    media.addEventListener("change", onViewportChange)
    return () => media.removeEventListener("change", onViewportChange)
  }, [visible])

  const push = (s: Screen) => { setUserMenuOpen(false); setStack(prev => [...prev, s]) }
  const pop = () => setStack(prev => prev.slice(0, -1))
  const openProject = (id: string) => { setSelectedProjectId(id); push("project-detail") }
  const selectedProject = props.project.items.find(p => p.id === selectedProjectId) ?? null
  const openConvMenu = (id: string, anchor: SidebarAnchor) => { setActionAnchor(anchor); setActionConvId(id) }
  const closeConvMenu = () => setActionConvId(null)
  const actionConv = conversations.find(c => c.id === actionConvId) ?? null
  // 根列表显示所有非草稿对谈（包括项目对话）；置顶在前
  const rootConversations = sortConversations(conversations.filter(c => !c.draft))
  const handleSelect = (id: string) => { setStack([]); setUserMenuOpen(false); props.conversation.select(id) }
  const handleNew = () => { setStack([]); setUserMenuOpen(false); props.conversation.create() }

  function screenStyle(s: Screen): React.CSSProperties {
    const inStack = stack.includes(s)
    return {
      transform: inStack ? "translateX(0)" : "translateX(100%)",
      zIndex: Z[s],
      pointerEvents: inStack ? "auto" : "none",
    }
  }

  const initial = (props.session.email.slice(0, 1) || "我").toUpperCase()

  const rootContent = (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-2 px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
        <Feather className="size-4 text-sidebar-primary" />
        <span className="font-heading text-base tracking-wide">My Chat</span>
        {onClose && (
          <button onClick={onClose} aria-label="收起侧栏" className="ml-auto rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground md:hidden">
            <PanelLeft className="size-5" />
          </button>
        )}
      </div>

      <button
        onClick={handleNew}
        className="mx-4 mb-2 flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
      >
        <Plus className="size-4 text-sidebar-primary" />
        新对话
      </button>

      <nav className="mx-4 space-y-0.5">
        <NavRow icon={<Folder className="size-4" />} label="项目" onClick={() => push("projects")} />
        <NavRow icon={<Shapes className="size-4" />} label="作品" onClick={() => { setStack([]); setUserMenuOpen(false); props.session.openArtifacts() }} />
        <NavRow icon={<Code2 className="size-4" />} label="代码" onClick={() => { setStack([]); setUserMenuOpen(false); props.session.openCode() }} />
      </nav>

      <div className="mx-7 my-3 border-t border-sidebar-border/60" />
      <p className="px-7 pb-2 text-[10px] tracking-[0.2em] text-muted-foreground/70">近期</p>

      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
        {rootConversations.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] italic text-muted-foreground/60">还没有对谈</p>
        ) : rootConversations.map(c => (
          <ConversationRow
            key={c.id}
            c={c}
            isActive={c.id === activeId}
            renaming={renamingId === c.id}
            onSelect={handleSelect}
            onOpenMenu={openConvMenu}
            onCommitRename={(id, t) => { props.conversation.rename(id, t); setRenamingId(null) }}
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
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{props.session.email || "已登录"}</span>
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
            <button onClick={props.session.logout} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-destructive">
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
          memories={props.memory.items}
          memoryEnabled={props.memory.enabled}
          onMemoryEnabledChange={props.memory.setEnabled}
          onMemoryAdd={props.memory.add}
          onMemoryEdit={props.memory.edit}
          onMemoryDelete={props.memory.delete}
          modelEndpoints={props.model.endpoints}
          activeEndpointId={props.model.activeId}
          onEndpointSelect={props.model.select}
          onEndpointCreated={props.model.created}
          onEndpointUpdated={props.model.updated}
          onEndpointDeleted={props.model.deleted}
        />
      </ScreenPanel>

      <ScreenPanel style={screenStyle("projects")} title="项目" onBack={pop}>
        <ProjectsScreen
          projects={props.project.items}
          conversations={conversations}
          onCreate={props.project.create}
          onOpen={openProject}
          onDelete={props.project.delete}
        />
      </ScreenPanel>

      <ScreenPanel
        style={screenStyle("project-detail")}
        onBack={pop}
        title={
          projectRenaming && selectedProject ? (
            <ProjectTitleEditor
              name={selectedProject.name}
              onSave={(n) => { props.project.rename(selectedProject.id, n); setProjectRenaming(false) }}
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
            onNewChat={props.project.createConversation}
            onInstructions={props.project.setInstructions}
            onLoadFiles={props.project.loadFiles}
            onAddFile={props.project.addFile}
            onDeleteFile={props.project.deleteFile}
            onLoadProjectMemories={props.project.loadMemories}
            onAddProjectMemory={(content) => props.project.addMemory(selectedProject.id, content)}
            onEditProjectMemory={props.project.editMemory}
            onDeleteProjectMemory={props.project.deleteMemory}
            renamingId={renamingId}
            onOpenConvMenu={openConvMenu}
            onRenameConversation={props.conversation.rename}
            onStopRename={() => setRenamingId(null)}
          />
        )}
      </ScreenPanel>

    </>
  )

  // 会话「更多菜单」：锚定在 ⋯ 旁的弹层（portal 到 body，避免被滚动容器/抽屉变换裁切）
  const convMenu = actionConv && actionAnchor && (
    <ConversationMenu
      conversation={actionConv}
      anchor={actionAnchor}
      projects={props.project.items}
      onClose={closeConvMenu}
      onToggleStar={() => { props.conversation.toggleStar(actionConv.id); closeConvMenu() }}
      onTogglePin={() => { props.conversation.togglePin(actionConv.id); closeConvMenu() }}
      onRename={() => { setRenamingId(actionConv.id); closeConvMenu() }}
      onMove={(pid) => { props.conversation.move(actionConv.id, pid); closeConvMenu() }}
      onDelete={() => { props.conversation.delete(actionConv.id); closeConvMenu() }}
    />
  )

  // 项目「更多菜单」：锚定在项目详情顶部 ⋯ 旁，重命名 / 删除
  const projectMenu = selectedProject && projectMenuAnchor && (
    <ProjectMenu
      anchor={projectMenuAnchor}
      onClose={() => setProjectMenuAnchor(null)}
      onRename={() => { setProjectRenaming(true); setProjectMenuAnchor(null) }}
      onDelete={() => { props.project.delete(selectedProject.id); setProjectMenuAnchor(null); pop() }}
    />
  )

  return (
    <aside className="relative h-full w-full overflow-hidden bg-transparent text-sidebar-foreground md:bg-sidebar">
      <div className={cn(
        "absolute left-0 top-0 z-10 h-full w-[min(20rem,82vw)] overflow-hidden bg-sidebar shadow-2xl transition-transform duration-300 ease-out md:relative md:w-full md:translate-x-0 md:shadow-none",
        visible ? "translate-x-0" : "-translate-x-full",
      )}>
        {rootContent}
      </div>
      {screens}
      {convMenu}
      {projectMenu}
    </aside>
  )
}
