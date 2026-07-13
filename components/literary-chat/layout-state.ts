"use client"

import { useState } from "react"

export function useLiteraryChatLayoutState() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const [artifactLibraryOpen, setArtifactLibraryOpen] = useState(false)
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null)
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState<{ bottom: number; left: number } | null>(null)
  const [headerRenaming, setHeaderRenaming] = useState(false)

  return {
    artifactLibraryOpen,
    codeOpen,
    drawerOpen,
    headerMenuAnchor,
    headerRenaming,
    openArtifactId,
    setArtifactLibraryOpen,
    setCodeOpen,
    setDrawerOpen,
    setHeaderMenuAnchor,
    setHeaderRenaming,
    setOpenArtifactId,
    setSidebarCollapsed,
    sidebarCollapsed,
  }
}

export type LiteraryChatLayoutState = ReturnType<typeof useLiteraryChatLayoutState>
