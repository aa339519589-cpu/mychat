"use client"

import { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react"
import type { User } from "@supabase/supabase-js"
import type { Conversation } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import type { Project, ProjectContext, ProjectFile } from "@/lib/project-data"
import {
  deleteProjectFileRow,
  deleteProjectMemoryRow,
  deleteProjectRow,
  fetchProjectContext,
  fetchProjectFiles,
  fetchProjectMemories,
  insertProject,
  insertProjectFile,
  insertProjectMemory,
  updateProject,
  updateProjectMemory,
} from "@/lib/data"
import { prepareFile } from "@/lib/file-extract"

type UseProjectsOptions = {
  user: User | null
  draftIdRef: MutableRefObject<string | null>
  setActiveId: Dispatch<SetStateAction<string>>
  setConversations: Dispatch<SetStateAction<Conversation[]>>
  setDrawerOpen: Dispatch<SetStateAction<boolean>>
}

export function useProjects(options: UseProjectsOptions) {
  const { user, draftIdRef, setActiveId, setConversations, setDrawerOpen } = options
  const [projects, setProjects] = useState<Project[]>([])
  const contextCacheRef = useRef<Map<string, ProjectContext>>(new Map())

  function resetProjects() {
    setProjects([])
    contextCacheRef.current.clear()
  }

  async function getProjectContext(projectId?: string | null): Promise<ProjectContext | undefined> {
    if (!projectId) return undefined
    const cached = contextCacheRef.current.get(projectId)
    if (cached) return cached
    const context = await fetchProjectContext(projectId)
    contextCacheRef.current.set(projectId, context)
    return context
  }

  async function handleProjectCreate(name: string): Promise<Project | null> {
    if (!user) return null
    const project = await insertProject(user.id, name)
    if (project) setProjects(previous => [project, ...previous])
    return project
  }

  function handleProjectRename(id: string, name: string) {
    setProjects(previous => previous.map(project => project.id === id ? { ...project, name } : project))
    updateProject(id, { name })
  }

  function handleProjectInstructions(id: string, instructions: string) {
    setProjects(previous => previous.map(project => project.id === id ? { ...project, instructions } : project))
    updateProject(id, { instructions })
    contextCacheRef.current.delete(id)
  }

  function handleProjectDelete(id: string) {
    setProjects(previous => previous.filter(project => project.id !== id))
    contextCacheRef.current.delete(id)
    setConversations(previous => previous.map(conversation => conversation.projectId === id
      ? { ...conversation, projectId: null }
      : conversation))
    deleteProjectRow(id)
  }

  function handleNewInProject(projectId: string) {
    if (!user) return null
    setDrawerOpen(false)
    if (draftIdRef.current) {
      const draftId = draftIdRef.current
      setConversations(previous => previous.map(conversation => conversation.id === draftId
        ? { ...conversation, projectId }
        : conversation))
      setActiveId(draftId)
      return draftId
    }
    const id = crypto.randomUUID()
    draftIdRef.current = id
    setConversations(previous => [{
      id,
      title: "未命名的篇章",
      excerpt: "",
      date: "今日",
      messages: [],
      draft: true,
      projectId,
    }, ...previous])
    setActiveId(id)
    return id
  }

  async function handleLoadProjectFiles(projectId: string): Promise<ProjectFile[]> {
    return fetchProjectFiles(projectId)
  }

  async function handleAddProjectFile(projectId: string, file: File): Promise<ProjectFile | null> {
    if (!user) return null
    try {
      const prepared = await prepareFile(file)
      const saved = await insertProjectFile(user.id, projectId, prepared.name, prepared.text ?? "")
      if (saved) contextCacheRef.current.delete(projectId)
      return saved
    } catch {
      return null
    }
  }

  function handleDeleteProjectFile(fileId: string) {
    deleteProjectFileRow(fileId)
    contextCacheRef.current.clear()
  }

  async function handleLoadProjectMemories(projectId: string): Promise<Memory[]> {
    return fetchProjectMemories(projectId)
  }

  async function handleAddProjectMemory(projectId: string, content: string): Promise<Memory | null> {
    if (!user) return null
    const memory = await insertProjectMemory(user.id, projectId, content)
    if (memory) contextCacheRef.current.delete(projectId)
    return memory
  }

  function handleEditProjectMemory(id: string, content: string) {
    updateProjectMemory(id, content)
    contextCacheRef.current.clear()
  }

  function handleDeleteProjectMemory(id: string) {
    deleteProjectMemoryRow(id)
    contextCacheRef.current.clear()
  }

  return {
    projects,
    setProjects,
    resetProjects,
    getProjectContext,
    handleProjectCreate,
    handleProjectRename,
    handleProjectInstructions,
    handleProjectDelete,
    handleNewInProject,
    handleLoadProjectFiles,
    handleAddProjectFile,
    handleDeleteProjectFile,
    handleLoadProjectMemories,
    handleAddProjectMemory,
    handleEditProjectMemory,
    handleDeleteProjectMemory,
  }
}
