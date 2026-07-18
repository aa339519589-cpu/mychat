"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { Message } from "@/lib/chat-data"

type ExternalHandlers = {
  onRegenerate?: () => void
  onEditUserMessage?: (messageId: string, content: string) => void
  onRegenerateFromUser?: (messageId: string) => void
  onOpenArtifact?: (messageId: string) => void
}

function useExternalMessageActions(handlers: ExternalHandlers) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const editUserMessage = useCallback((messageId: string, content: string) => {
    handlersRef.current.onEditUserMessage?.(messageId, content)
  }, [])
  const regenerateFromUser = useCallback((messageId: string) => {
    handlersRef.current.onRegenerateFromUser?.(messageId)
  }, [])
  const openArtifact = useCallback((messageId: string) => {
    handlersRef.current.onOpenArtifact?.(messageId)
  }, [])
  const regenerateAssistant = useCallback(() => {
    handlersRef.current.onRegenerate?.()
  }, [])

  return { editUserMessage, regenerateFromUser, openArtifact, regenerateAssistant }
}

function useEditableMessageState({
  conversationId,
  isLoading,
  editUserMessage,
}: {
  conversationId: string
  isLoading: boolean
  editUserMessage: (messageId: string, content: string) => void
}) {
  const [activeUserId, setActiveUserId] = useState<string | null>(null)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState("")
  const loadingRef = useRef(isLoading)
  const editingUserIdRef = useRef<string | null>(null)
  const editDraftRef = useRef("")
  loadingRef.current = isLoading

  useEffect(() => {
    setActiveUserId(null)
    setEditingUserId(null)
    setEditDraft("")
    editingUserIdRef.current = null
    editDraftRef.current = ""
  }, [conversationId])

  const toggleActive = useCallback((messageId: string) => {
    setActiveUserId(current => current === messageId ? null : messageId)
  }, [])
  const startEdit = useCallback((message: Message) => {
    if (loadingRef.current) return
    editingUserIdRef.current = message.id
    editDraftRef.current = message.content
    setActiveUserId(message.id)
    setEditingUserId(message.id)
    setEditDraft(message.content)
  }, [])
  const updateEditDraft = useCallback((value: string) => {
    editDraftRef.current = value
    setEditDraft(value)
  }, [])
  const cancelEdit = useCallback(() => {
    editingUserIdRef.current = null
    editDraftRef.current = ""
    setEditingUserId(null)
    setEditDraft("")
  }, [])
  const commitEdit = useCallback(() => {
    const messageId = editingUserIdRef.current
    const text = editDraftRef.current.trim()
    if (!messageId || !text) return
    editUserMessage(messageId, text)
    editingUserIdRef.current = null
    editDraftRef.current = ""
    setEditingUserId(null)
    setEditDraft("")
  }, [editUserMessage])

  return {
    activeUserId,
    editingUserId,
    editDraft,
    toggleActive,
    startEdit,
    updateEditDraft,
    cancelEdit,
    commitEdit,
  }
}

export function useMessageListController({
  conversationId,
  isLoading,
  handlers,
}: {
  conversationId: string
  isLoading: boolean
  handlers: ExternalHandlers
}) {
  const external = useExternalMessageActions(handlers)
  const editing = useEditableMessageState({
    conversationId,
    isLoading,
    editUserMessage: external.editUserMessage,
  })
  return { ...editing, ...external }
}
