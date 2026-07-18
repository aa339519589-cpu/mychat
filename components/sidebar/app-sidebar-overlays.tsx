"use client"

import { AnimatePresence } from "motion/react"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import { ConversationMenu } from "@/components/conversation-menu"
import { ProjectMenu } from "@/components/sidebar/primitives"
import type { SidebarAnchor } from "./shared"

export type SidebarOverlaysProps = {
  actionConv: Conversation | null
  actionAnchor: SidebarAnchor | null
  selectedProject: Project | null
  projectMenuAnchor: SidebarAnchor | null
  projects: Project[]
  onCloseConversation: () => void
  onToggleStar: () => void
  onTogglePin: () => void
  onRenameConversation: () => void
  onMoveConversation: (projectId: string | null) => void
  onDeleteConversation: () => void
  onCloseProject: () => void
  onRenameProject: () => void
  onDeleteProject: () => void
}

export function SidebarOverlays(props: SidebarOverlaysProps) {
  return (
    <>
      <AnimatePresence initial={false}>{props.actionConv && props.actionAnchor && <ConversationOverlay {...props} />}</AnimatePresence>
      <AnimatePresence initial={false}>{props.selectedProject && props.projectMenuAnchor && <ProjectOverlay {...props} />}</AnimatePresence>
    </>
  )
}

function ConversationOverlay({ actionConv, actionAnchor, projects, onCloseConversation, onToggleStar, onTogglePin, onRenameConversation, onMoveConversation, onDeleteConversation }: SidebarOverlaysProps) {
  return <ConversationMenu key={actionConv!.id} conversation={actionConv!} anchor={actionAnchor!} projects={projects} onClose={onCloseConversation} onToggleStar={onToggleStar} onTogglePin={onTogglePin} onRename={onRenameConversation} onMove={onMoveConversation} onDelete={onDeleteConversation} />
}

function ProjectOverlay({ selectedProject, projectMenuAnchor, onCloseProject, onRenameProject, onDeleteProject }: SidebarOverlaysProps) {
  return <ProjectMenu key={selectedProject!.id} anchor={projectMenuAnchor!} onClose={onCloseProject} onRename={onRenameProject} onDelete={onDeleteProject} />
}
