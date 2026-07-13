"use client"

import type { ComponentProps, RefObject } from "react"
import type { User } from "@supabase/supabase-js"
import type { Conversation } from "@/lib/chat-data"
import type { Project } from "@/lib/project-data"
import { AppSidebar } from "@/components/app-sidebar"
import { ArtifactPanel } from "@/components/artifact-panel"
import { ChatInput } from "@/components/chat-input"
import { CodeConsole } from "@/components/code-console"
import { ConversationMenu } from "@/components/conversation-menu"
import { MessageList } from "@/components/message-list"
import { artifactTitle, parseArtifact } from "@/lib/artifact"
import { cn } from "@/lib/utils"
import { ChatPane } from "./chat-pane"
import type { LiteraryChatLayoutState } from "./layout-state"

type ConversationActions = {
  rename: (id: string, title: string) => void
  delete: (id: string) => void
  toggleStar: (id: string) => void
  togglePin: (id: string) => void
  move: (id: string, projectId: string | null) => void
}

type LiteraryChatViewProps = {
  user: User
  active?: Conversation
  activeProject: Project | null
  projects: Project[]
  sidebarProps: ComponentProps<typeof AppSidebar>
  layout: LiteraryChatLayoutState
  desktopScrollRef: RefObject<HTMLDivElement | null>
  mobileScrollRef: RefObject<HTMLDivElement | null>
  conversationActions: ConversationActions
  messageProps: Omit<ComponentProps<typeof MessageList>, "conversation">
  inputProps: Omit<ComponentProps<typeof ChatInput>, "mobile">
}

function MobileDrawer({ layout, sidebarProps }: Pick<LiteraryChatViewProps, "layout" | "sidebarProps">) {
  return (
    <div className={cn("fixed inset-0 z-40", layout.drawerOpen ? "pointer-events-auto" : "pointer-events-none")}>
      <button
        type="button"
        aria-label="收起侧栏"
        onClick={() => layout.setDrawerOpen(false)}
        className={cn(
          "absolute inset-0 bg-black/50 transition-opacity duration-300",
          layout.drawerOpen ? "opacity-100" : "opacity-0",
        )}
      />
      <AppSidebar {...sidebarProps} mobile visible={layout.drawerOpen} onClose={() => layout.setDrawerOpen(false)} />
    </div>
  )
}

export function LiteraryChatView(props: LiteraryChatViewProps) {
  const { user, active, activeProject, projects, sidebarProps, layout, conversationActions } = props
  const openMessage = layout.openArtifactId ? active?.messages.find(message => message.id === layout.openArtifactId) : null
  const artifact = openMessage ? parseArtifact(openMessage.content) : null
  const showArtifact = Boolean(artifact && artifact.raw !== null)
  const paneProps = {
    active,
    activeProject,
    menuAnchor: layout.headerMenuAnchor,
    renaming: layout.headerRenaming,
    onOpenSidebar: () => layout.setDrawerOpen(true),
    onToggleSidebar: () => layout.setSidebarCollapsed(value => !value),
    onMenuAnchorChange: layout.setHeaderMenuAnchor,
    onRenamingChange: layout.setHeaderRenaming,
    onRename: conversationActions.rename,
    messageProps: props.messageProps,
    inputProps: props.inputProps,
  }

  return (
    <>
      {layout.codeOpen && <CodeConsole userId={user.id} onExit={() => layout.setCodeOpen(false)} />}
      <div className="hidden h-dvh min-h-0 w-full overflow-hidden bg-background py-4 pr-4 pl-0 paper-grain md:flex">
        <div className={cn("shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out", layout.sidebarCollapsed ? "w-0" : "w-[20rem]")}>
          <div className="h-full w-[20rem] overflow-hidden border-r border-border/50 bg-sidebar/40">
            <AppSidebar {...sidebarProps} />
          </div>
        </div>
        <ChatPane {...paneProps} mobile={false} scrollRef={props.desktopScrollRef} />
        {showArtifact && (
          <aside className="ml-2 hidden w-[44%] min-w-[360px] max-w-[720px] shrink-0 overflow-hidden rounded-2xl border border-border/50 md:block">
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

      <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-background paper-grain md:hidden">
        <MobileDrawer layout={layout} sidebarProps={sidebarProps} />
        <ChatPane {...paneProps} mobile scrollRef={props.mobileScrollRef} />
        {showArtifact && (
          <div className="fixed inset-0 z-50 bg-background">
            <ArtifactPanel
              key={layout.openArtifactId}
              raw={artifact!.raw!}
              done={artifact!.done}
              title={artifactTitle(artifact!.raw!)}
              onClose={() => layout.setOpenArtifactId(null)}
            />
          </div>
        )}
      </div>

      {active && !active.draft && layout.headerMenuAnchor && (
        <ConversationMenu
          conversation={active}
          anchor={layout.headerMenuAnchor}
          projects={projects}
          onClose={() => layout.setHeaderMenuAnchor(null)}
          onToggleStar={() => { conversationActions.toggleStar(active.id); layout.setHeaderMenuAnchor(null) }}
          onTogglePin={() => { conversationActions.togglePin(active.id); layout.setHeaderMenuAnchor(null) }}
          onRename={() => { layout.setHeaderMenuAnchor(null); layout.setHeaderRenaming(true) }}
          onMove={projectId => { conversationActions.move(active.id, projectId); layout.setHeaderMenuAnchor(null) }}
          onDelete={() => { conversationActions.delete(active.id); layout.setHeaderMenuAnchor(null) }}
        />
      )}
    </>
  )
}
