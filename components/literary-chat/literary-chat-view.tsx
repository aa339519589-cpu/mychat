"use client"

import type { ComponentProps, RefObject } from "react"
import dynamic from "next/dynamic"
import type { User } from "@supabase/supabase-js"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import { AppSidebar } from "@/components/app-sidebar"
import { ArtifactPanel } from "@/components/artifact-panel"
import type { ArtifactLibraryOverlayProps } from "@/components/artifact-library-overlay"
import type { CodeConsoleProps } from "@/components/code-console"
import { ChatInput } from "@/components/chat-input"
import { ConversationMenu } from "@/components/conversation-menu"
import { MessageList } from "@/components/message-list"
import { artifactTitle, parseArtifact } from "@/lib/artifact"
import { cn } from "@/lib/utils"
import { ChatPane } from "./chat-pane"
import type { LiteraryChatLayoutState } from "./layout-state"
import { useMediaQuery } from "./use-media-query"

const LazyCodeConsole = dynamic<CodeConsoleProps>(
  () => import("@/components/code-console").then(module => module.CodeConsole),
  { ssr: false, loading: () => <div className="fixed inset-0 z-[80] bg-background paper-grain" /> },
)
const LazyArtifactLibrary = dynamic<ArtifactLibraryOverlayProps>(
  () => import("@/components/artifact-library-overlay").then(module => module.ArtifactLibraryOverlay),
  { ssr: false },
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

function ResponsiveSidebar({
  layout,
  sidebar,
}: Pick<LiteraryChatViewController, "layout" | "sidebar">) {
  return (
    <div className={cn(
      "fixed inset-0 z-40 shrink-0 md:relative md:inset-auto md:z-auto md:h-full md:overflow-hidden md:transition-[width] md:duration-300 md:ease-in-out",
      layout.drawerOpen ? "pointer-events-auto" : "pointer-events-none md:pointer-events-auto",
      layout.sidebarCollapsed ? "md:w-0" : "md:w-[20rem]",
    )}>
      <button
        type="button"
        aria-label="收起侧栏"
        onClick={() => layout.setDrawerOpen(false)}
        className={cn(
          "absolute inset-0 bg-black/50 transition-opacity duration-300 md:hidden",
          layout.drawerOpen ? "opacity-100" : "opacity-0",
        )}
      />
      <div className="relative h-full w-full md:w-[20rem] md:overflow-hidden md:border-r md:border-border/50 md:bg-sidebar/40">
        <AppSidebar
          {...sidebar}
          visible={layout.drawerOpen}
          onClose={() => layout.setDrawerOpen(false)}
        />
      </div>
    </div>
  )
}

export function LiteraryChatView({ controller }: { controller: LiteraryChatViewController }) {
  const { session, conversation, sidebar, layout, chat } = controller
  const { active, activeProject, projects, actions } = conversation
  const mobile = useMediaQuery("(max-width: 767px)")
  const openMessage = layout.openArtifactId
    ? active?.messages.find(message => message.id === layout.openArtifactId)
    : null
  const artifact = openMessage ? parseArtifact(openMessage.content) : null
  const showArtifact = Boolean(artifact && artifact.raw !== null)

  return (
    <>
      {layout.codeOpen && <LazyCodeConsole userId={session.user.id} onExit={() => layout.setCodeOpen(false)} />}
      {layout.artifactLibraryOpen && (
        <LazyArtifactLibrary open onClose={() => layout.setArtifactLibraryOpen(false)} />
      )}

      <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background paper-grain md:py-4 md:pr-4">
        <ResponsiveSidebar layout={layout} sidebar={sidebar} />
        <ChatPane
          mobile={mobile}
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
        {showArtifact && (
          <aside className="fixed inset-0 z-50 overflow-hidden bg-background md:relative md:inset-auto md:z-auto md:ml-2 md:w-[44%] md:min-w-[360px] md:max-w-[720px] md:shrink-0 md:rounded-2xl md:border md:border-border/50">
            <ArtifactPanel
              key={layout.openArtifactId}
              raw={artifact!.raw!}
              done={artifact!.done}
              title={artifactTitle(artifact!.raw!)}
              onClose={() => layout.setOpenArtifactId(null)}
            />
          </aside>
        )}
      </div>

      {active && !active.draft && layout.headerMenuAnchor && (
        <ConversationMenu
          conversation={active}
          anchor={layout.headerMenuAnchor}
          projects={projects}
          onClose={() => layout.setHeaderMenuAnchor(null)}
          onToggleStar={() => { actions.toggleStar(active.id); layout.setHeaderMenuAnchor(null) }}
          onTogglePin={() => { actions.togglePin(active.id); layout.setHeaderMenuAnchor(null) }}
          onRename={() => { layout.setHeaderMenuAnchor(null); layout.setHeaderRenaming(true) }}
          onMove={projectId => { actions.move(active.id, projectId); layout.setHeaderMenuAnchor(null) }}
          onDelete={() => { actions.delete(active.id); layout.setHeaderMenuAnchor(null) }}
        />
      )}
    </>
  )
}
