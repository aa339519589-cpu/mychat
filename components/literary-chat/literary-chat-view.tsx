"use client"

import { useEffect, useState, type ComponentProps, type RefObject } from "react"
import type { User } from "@supabase/supabase-js"
import dynamic from "next/dynamic"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import { AppSidebar } from "@/components/app-sidebar"
import type { ArtifactLibraryOverlayProps } from "@/components/artifact-library-overlay"
import type { CodeConsoleProps } from "@/components/code-console"
import type { HealthWorkspaceProps } from "@/components/health/health-workspace"
import { ChatInput } from "@/components/chat-input"
import { MessageList } from "@/components/message-list"
import { parseArtifact } from "@/lib/artifact"
import { ChatPane } from "./chat-pane"
import type { LiteraryChatLayoutState } from "./layout-state"
import { ResponsiveSidebar } from "./responsive-sidebar"
import { useMediaQuery } from "./use-media-query"
import { ViewOverlays } from "./view-overlays"

const LazyCodeConsole = dynamic<CodeConsoleProps>(
  () => import("@/components/code-console").then(module => module.CodeConsole),
  { ssr: false, loading: () => <div className="fixed inset-0 z-[80] bg-background paper-grain" /> },
)
const LazyArtifactLibrary = dynamic<ArtifactLibraryOverlayProps>(
  () => import("@/components/artifact-library-overlay").then(module => module.ArtifactLibraryOverlay),
  { ssr: false },
)
const LazyHealthWorkspace = dynamic<HealthWorkspaceProps>(
  () => import("@/components/health/health-workspace").then(module => module.HealthWorkspace),
  { ssr: false, loading: () => <div className="fixed inset-0 z-[70] bg-background paper-grain" /> },
)

export type ConversationActions = {
  rename: (id: string, title: string) => void
  delete: (id: string) => void
  toggleStar: (id: string) => void
  togglePin: (id: string) => void
  move: (id: string, projectId: string | null) => void
}

export type LiteraryChatViewController = {
  session: { user: User }
  conversation: {
    active?: Conversation
    activeProject: Project | null
    projects: Project[]
    actions: ConversationActions
  }
  sidebar: ComponentProps<typeof AppSidebar>
  layout: LiteraryChatLayoutState
  chat: {
    scrollRef: RefObject<HTMLDivElement | null>
    messages: Omit<ComponentProps<typeof MessageList>, "conversation">
    input: Omit<ComponentProps<typeof ChatInput>, "mobile">
  }
}

export function LiteraryChatView({ controller }: { controller: LiteraryChatViewController }) {
  const { session, conversation, sidebar, layout, chat } = controller
  const { active, activeProject, projects, actions } = conversation
  const mobile = useMediaQuery("(max-width: 767px)")
  const [artifactPanelWidth, setArtifactPanelWidth] = useState(520)

  useEffect(() => {
    const updateWidth = () => setArtifactPanelWidth(Math.min(720, Math.max(360, window.innerWidth * 0.44)))
    updateWidth()
    window.addEventListener("resize", updateWidth, { passive: true })
    return () => window.removeEventListener("resize", updateWidth)
  }, [])
  const openMessage = layout.openArtifactId
    ? active?.messages.find(message => message.id === layout.openArtifactId)
    : null
  const artifact = openMessage ? parseArtifact(openMessage.content) : null

  return (
    <>
      <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background paper-grain md:py-4 md:pr-4">
        <ResponsiveSidebar layout={layout} sidebar={sidebar} mobile={mobile} />
        <ChatPane
          mobile={mobile}
          sidebarCollapsed={layout.sidebarCollapsed}
          active={active}
          activeProject={activeProject}
          scrollRef={chat.scrollRef}
          menuAnchor={layout.headerMenuAnchor}
          renaming={layout.headerRenaming}
          onOpenSidebar={() => layout.setDrawerOpen(true)}
          onToggleSidebar={() => layout.setSidebarCollapsed(value => !value)}
          onMenuAnchorChange={layout.setHeaderMenuAnchor}
          onRenamingChange={layout.setHeaderRenaming}
          onRename={actions.rename}
          messageProps={chat.messages}
          inputProps={chat.input}
        />
        <ViewOverlays sessionUserId={session.user.id} layout={layout} active={active} projects={projects} actions={actions} mobile={mobile} artifact={artifact} artifactPanelWidth={artifactPanelWidth} codeConsole={LazyCodeConsole} artifactLibrary={LazyArtifactLibrary} healthWorkspace={LazyHealthWorkspace} />
      </div>
    </>
  )
}
