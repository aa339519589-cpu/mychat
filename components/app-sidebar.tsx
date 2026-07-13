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
import { ComingSoon, ConversationRow, NavRow, ProjectMenu, ScreenPanel } from "@/components/sidebar/primitives"
import { ProjectDetailScreen, ProjectsScreen, ProjectTitleEditor } from "@/components/sidebar/projects"
import { SettingsScreen } from "@/components/sidebar/settings"
import { sortConversations, type SidebarAnchor } from "@/components/sidebar/shared"

// 二级页面：除根视图（侧栏主体）外的可滑入全屏页面。设置＝真正的二级滑入页（带返回头）。
type Screen = "settings" | "projects" | "artifacts" | "project-detail"

// 层级 z：设置/项目/作品为一级(20)，项目详情为二级(30)，均高于根面板(10)。
const Z: Record<Screen, number> = {
  settings: 20, projects: 20, artifacts: 20, "project-detail": 30,
}

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
  modelEndpoints: ModelEndpointSummary[]
  activeEndpointId: string | null
  onEndpointSelect: (id: string) => void
  onEndpointCreated: (endpoint: ModelEndpointSummary) => void
  onEndpointUpdated: (endpoint: ModelEndpointSummary) => void
  onEndpointDeleted: (id: string) => void
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
  const [actionAnchor, setActionAnchor] = useState<SidebarAnchor | null>(null)   // ⋯ 按钮的位置
  const [renamingId, setRenamingId] = useState<string | null>(null)       // 正在改名的会话
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<SidebarAnchor | null>(null) // 项目详情 ⋯ 菜单位置
  const [projectRenaming, setProjectRenaming] = useState(false)           // 项目详情顶部就地改名

  // 抽屉收起后复位到根视图
  useEffect(() => { if (!visible) { setStack([]); setUserMenuOpen(false); setSelectedProjectId(null); setActionConvId(null); setRenamingId(null); setProjectMenuAnchor(null); setProjectRenaming(false) } }, [visible])

  const push = (s: Screen) => { setUserMenuOpen(false); setStack(prev => [...prev, s]) }
  const pop = () => setStack(prev => prev.slice(0, -1))
  const openProject = (id: string) => { setSelectedProjectId(id); push("project-detail") }
  const selectedProject = props.projects.find(p => p.id === selectedProjectId) ?? null
  const openConvMenu = (id: string, anchor: SidebarAnchor) => { setActionAnchor(anchor); setActionConvId(id) }
  const closeConvMenu = () => setActionConvId(null)
  const actionConv = conversations.find(c => c.id === actionConvId) ?? null
  // 根列表显示所有非草稿对谈（包括项目对话）；置顶在前
  const rootConversations = sortConversations(conversations.filter(c => !c.draft))
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
        新对话
      </button>

      <nav className="mx-4 space-y-0.5">
        <NavRow icon={<Folder className="size-4" />} label="项目" onClick={() => push("projects")} />
        <NavRow icon={<Shapes className="size-4" />} label="作品" onClick={() => push("artifacts")} />
        <NavRow icon={<Code2 className="size-4" />} label="代码" onClick={() => { setStack([]); setUserMenuOpen(false); props.onOpenCode() }} />
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
          modelEndpoints={props.modelEndpoints}
          activeEndpointId={props.activeEndpointId}
          onEndpointSelect={props.onEndpointSelect}
          onEndpointCreated={props.onEndpointCreated}
          onEndpointUpdated={props.onEndpointUpdated}
          onEndpointDeleted={props.onEndpointDeleted}
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
    <ConversationMenu
      conversation={actionConv}
      anchor={actionAnchor}
      projects={props.projects}
      onClose={closeConvMenu}
      onToggleStar={() => { props.onToggleStar(actionConv.id); closeConvMenu() }}
      onTogglePin={() => { props.onTogglePin(actionConv.id); closeConvMenu() }}
      onRename={() => { setRenamingId(actionConv.id); closeConvMenu() }}
      onMove={(pid) => { props.onAddToProject(actionConv.id, pid); closeConvMenu() }}
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
