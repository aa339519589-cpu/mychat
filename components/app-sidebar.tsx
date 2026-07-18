"use client"

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react"
import type { Conversation } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import type { Project, ProjectFile } from "@/lib/project-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { sortConversations, type SidebarAnchor, type SidebarScreen } from "@/components/sidebar/shared"
import { SidebarRootContent } from "@/components/sidebar/app-sidebar-content"
import { SidebarOverlays } from "@/components/sidebar/app-sidebar-overlays"
import { SidebarScreens } from "@/components/sidebar/app-sidebar-screens"

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
  visible = false, onClose, onDragStart, onDragMove, onDragEnd, onDragCancel, ...props
}: AppSidebarProps & {
  visible?: boolean
  onClose?: () => void
  onDragStart?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onDragMove?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onDragEnd?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onDragCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const { items: conversations, activeId } = props.conversation
  const [stack, setStack] = useState<SidebarScreen[]>([])
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [actionConvId, setActionConvId] = useState<string | null>(null)
  const [actionAnchor, setActionAnchor] = useState<SidebarAnchor | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<SidebarAnchor | null>(null)
  const [projectRenaming, setProjectRenaming] = useState(false)

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

  const push = (screen: SidebarScreen) => { setUserMenuOpen(false); setStack(prev => [...prev, screen]) }
  const pop = () => setStack(prev => prev.slice(0, -1))
  const openProject = (id: string) => { setSelectedProjectId(id); push("project-detail") }
  const selectedProject = props.project.items.find(p => p.id === selectedProjectId) ?? null
  const openConvMenu = (id: string, anchor: SidebarAnchor) => { setActionAnchor(anchor); setActionConvId(id) }
  const closeConvMenu = () => setActionConvId(null)
  const actionConv = conversations.find(c => c.id === actionConvId) ?? null
  const rootConversations = sortConversations(conversations.filter(c => !c.draft))
  const handleSelect = (id: string) => { setStack([]); setUserMenuOpen(false); props.conversation.select(id) }
  const handleNew = () => { setStack([]); setUserMenuOpen(false); props.conversation.create() }
  return (
    <aside className="relative h-full w-full overflow-hidden bg-sidebar text-sidebar-foreground">
      <div className="absolute inset-0 z-10 h-full w-full overflow-hidden bg-sidebar">
        <SidebarRootContent
          onClose={onClose}
          onDragStart={onDragStart}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
          stackDepth={stack.length}
          activeId={activeId}
          rootConversations={rootConversations}
          renamingId={renamingId}
          email={props.session.email}
          userMenuOpen={userMenuOpen}
          onNew={handleNew}
          onOpenProjects={() => push("projects")}
          onOpenArtifacts={() => { setStack([]); setUserMenuOpen(false); props.session.openArtifacts() }}
          onOpenCode={() => { setStack([]); setUserMenuOpen(false); props.session.openCode() }}
          onSelect={handleSelect}
          onOpenMenu={openConvMenu}
          onCommitRename={(id, title) => { props.conversation.rename(id, title); setRenamingId(null) }}
          onCancelRename={() => setRenamingId(null)}
          onToggleUserMenu={() => setUserMenuOpen(value => !value)}
          onCloseUserMenu={() => setUserMenuOpen(false)}
          onOpenSettings={() => push("settings")}
          onLogout={props.session.logout}
        />
      </div>
      <SidebarScreens
        {...props}
        stack={stack}
        conversations={conversations}
        selectedProject={selectedProject}
        projectRenaming={projectRenaming}
        renamingId={renamingId}
        projectMenuAnchor={projectMenuAnchor}
        onBack={pop}
        onOpenProject={openProject}
        onSelectConversation={handleSelect}
        onOpenConversationMenu={openConvMenu}
        onProjectMenuAnchor={setProjectMenuAnchor}
        onProjectRename={setProjectRenaming}
        onStopRename={() => setRenamingId(null)}
      />
      <SidebarOverlays
        actionConv={actionConv}
        actionAnchor={actionAnchor}
        selectedProject={selectedProject}
        projectMenuAnchor={projectMenuAnchor}
        projects={props.project.items}
        onCloseConversation={closeConvMenu}
        onToggleStar={() => { if (actionConv) props.conversation.toggleStar(actionConv.id); closeConvMenu() }}
        onTogglePin={() => { if (actionConv) props.conversation.togglePin(actionConv.id); closeConvMenu() }}
        onRenameConversation={() => { if (actionConv) setRenamingId(actionConv.id); closeConvMenu() }}
        onMoveConversation={projectId => { if (actionConv) props.conversation.move(actionConv.id, projectId); closeConvMenu() }}
        onDeleteConversation={() => { if (actionConv) props.conversation.delete(actionConv.id); closeConvMenu() }}
        onCloseProject={() => setProjectMenuAnchor(null)}
        onRenameProject={() => { setProjectRenaming(true); setProjectMenuAnchor(null) }}
        onDeleteProject={() => { if (selectedProject) props.project.delete(selectedProject.id); setProjectMenuAnchor(null); pop() }}
      />
    </aside>
  )
}
