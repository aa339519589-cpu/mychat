"use client"

import { MoreHorizontal } from "lucide-react"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import type { AppSidebarProps } from "@/components/app-sidebar"
import { ProjectDetailScreen, ProjectsScreen, ProjectTitleEditor } from "@/components/sidebar/projects"
import { SettingsScreen } from "@/components/sidebar/settings"
import { ScreenPanel } from "@/components/sidebar/primitives"
import { sidebarScreenStyle, type SidebarAnchor, type SidebarScreen } from "./shared"

type ScreenData = Pick<AppSidebarProps, "conversation" | "memory" | "project" | "model">

export type SidebarScreensProps = ScreenData & {
  stack: SidebarScreen[]
  conversations: Conversation[]
  selectedProject: Project | null
  projectRenaming: boolean
  renamingId: string | null
  projectMenuAnchor: SidebarAnchor | null
  onBack: () => void
  onOpenProject: (id: string) => void
  onSelectConversation: (id: string) => void
  onOpenConversationMenu: (id: string, anchor: SidebarAnchor) => void
  onProjectMenuAnchor: (anchor: SidebarAnchor | null) => void
  onProjectRename: (value: boolean) => void
  onStopRename: () => void
}

export function SidebarScreens(props: SidebarScreensProps) {
  return (
    <>
      <SettingsPanel {...props} />
      <ProjectsPanel {...props} />
      <ProjectDetailPanel {...props} />
    </>
  )
}

function SettingsPanel({ stack, memory, model, onBack }: SidebarScreensProps) {
  return (
    <ScreenPanel open={stack.includes("settings")} style={sidebarScreenStyle(stack, "settings")} title="设置" onBack={onBack}>
      <SettingsScreen memories={memory.items} memoryEnabled={memory.enabled} onMemoryEnabledChange={memory.setEnabled} onMemoryAdd={memory.add} onMemoryEdit={memory.edit} onMemoryDelete={memory.delete} modelEndpoints={model.endpoints} activeEndpointId={model.activeId} onEndpointSelect={model.select} onEndpointCreated={model.created} onEndpointUpdated={model.updated} onEndpointDeleted={model.deleted} />
    </ScreenPanel>
  )
}

function ProjectsPanel({ stack, project, conversations, onBack, onOpenProject }: SidebarScreensProps) {
  return (
    <ScreenPanel open={stack.includes("projects")} style={sidebarScreenStyle(stack, "projects")} title="项目" onBack={onBack}>
      <ProjectsScreen projects={project.items} conversations={conversations} onCreate={project.create} onOpen={onOpenProject} onDelete={project.delete} />
    </ScreenPanel>
  )
}

function ProjectDetailPanel(props: SidebarScreensProps) {
  const { stack, selectedProject, projectRenaming, project, conversation, conversations, renamingId, onBack, onSelectConversation, onOpenConversationMenu, onProjectMenuAnchor, onStopRename } = props
  return (
    <ScreenPanel open={stack.includes("project-detail")} style={sidebarScreenStyle(stack, "project-detail")} onBack={onBack} title={<ProjectTitle {...props} />} action={<ProjectAction project={selectedProject} editing={projectRenaming} onAnchor={onProjectMenuAnchor} />}>
      {selectedProject && <ProjectDetailScreen key={selectedProject.id} project={selectedProject} conversations={conversations} onOpenChat={onSelectConversation} onNewChat={project.createConversation} onInstructions={project.setInstructions} onLoadFiles={project.loadFiles} onAddFile={project.addFile} onDeleteFile={project.deleteFile} onLoadProjectMemories={project.loadMemories} onAddProjectMemory={content => project.addMemory(selectedProject.id, content)} onEditProjectMemory={project.editMemory} onDeleteProjectMemory={project.deleteMemory} renamingId={renamingId} onOpenConvMenu={onOpenConversationMenu} onRenameConversation={conversation.rename} onStopRename={onStopRename} />}
    </ScreenPanel>
  )
}

function ProjectTitle({ selectedProject, projectRenaming, project, onProjectRename }: SidebarScreensProps) {
  if (!projectRenaming || !selectedProject) return selectedProject?.name ?? "项目"
  return <ProjectTitleEditor name={selectedProject.name} onSave={name => { project.rename(selectedProject.id, name); onProjectRename(false) }} onCancel={() => onProjectRename(false)} />
}

function ProjectAction({ project, editing, onAnchor }: { project: Project | null; editing: boolean; onAnchor: (anchor: SidebarAnchor | null) => void }) {
  if (!project || editing) return undefined
  return <button aria-label="项目操作" onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); onAnchor({ top: bounds.top, bottom: bounds.bottom, right: bounds.right }) }} className="fluid-press fluid-icon-press fluid-touch-target flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"><MoreHorizontal className="size-5" /></button>
}
