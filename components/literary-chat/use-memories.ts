"use client"

import { useState } from "react"
import type { User } from "@supabase/supabase-js"
import type { Memory } from "@/lib/memory-data"
import { deleteMemoryRow, insertMemory, setMemoryEnabled, updateMemory } from "@/lib/data"

export function useMemories(user: User | null) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [memoryEnabled, setMemoryEnabledState] = useState(true)

  function restoreMemories(items: Memory[], enabled: boolean) {
    setMemories(items)
    setMemoryEnabledState(enabled)
  }

  function resetMemories() {
    setMemories([])
    setMemoryEnabledState(true)
  }

  async function handleMemoryAdd(content: string) {
    if (!user) return
    const memory = await insertMemory(user.id, content)
    if (memory) setMemories(previous => [...previous, memory])
  }

  function handleMemoryEdit(id: string, content: string) {
    const timestamp = new Date().toISOString()
    setMemories(previous => previous.map(memory => memory.id === id
      ? { ...memory, content, timestamp }
      : memory))
    updateMemory(id, content)
  }

  function handleMemoryDelete(id: string) {
    setMemories(previous => previous.filter(memory => memory.id !== id))
    deleteMemoryRow(id)
  }

  function handleMemoryEnabledChange(enabled: boolean) {
    setMemoryEnabledState(enabled)
    if (user) setMemoryEnabled(user.id, enabled)
  }

  return {
    memories,
    memoryEnabled,
    setMemories,
    restoreMemories,
    resetMemories,
    handleMemoryAdd,
    handleMemoryEdit,
    handleMemoryDelete,
    handleMemoryEnabledChange,
  }
}
