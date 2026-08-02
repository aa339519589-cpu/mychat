"use client"

import { useRef, useState } from "react"
import type { User } from "@supabase/supabase-js"
import type { Memory } from "@/lib/memory-data"
import { deleteMemoryRow, insertMemory, setMemoryEnabled, updateMemory } from "@/lib/data"

const MEMORY_SETTING_PREFIX = "mychat:memory-enabled:"

function settingKey(userId: string) {
  return `${MEMORY_SETTING_PREFIX}${userId}`
}

function readLocalSetting(userId: string): boolean | null {
  try {
    const value = window.localStorage.getItem(settingKey(userId))
    if (value === "true") return true
    if (value === "false") return false
  } catch {}
  return null
}

function writeLocalSetting(userId: string, enabled: boolean) {
  try { window.localStorage.setItem(settingKey(userId), String(enabled)) } catch {}
}

function clearLocalSetting(userId: string) {
  try { window.localStorage.removeItem(settingKey(userId)) } catch {}
}

export function useMemories(user: User | null) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [memoryEnabled, setMemoryEnabledState] = useState(true)
  const writeVersionRef = useRef(0)

  function persistMemorySetting(userId: string, enabled: boolean, version: number) {
    void setMemoryEnabled(userId, enabled)
      .then(() => {
        if (writeVersionRef.current === version) clearLocalSetting(userId)
      })
      .catch(error => {
        console.error("setMemoryEnabled", error)
        // 本地值继续保留。刷新、退出页面或短暂断网后仍以用户最后一次选择为准，下一次启动会重试。
      })
  }

  function restoreMemories(items: Memory[], enabled: boolean) {
    setMemories(items)
    if (!user) {
      setMemoryEnabledState(enabled)
      return
    }
    const local = readLocalSetting(user.id)
    const resolved = local ?? enabled
    setMemoryEnabledState(resolved)
    if (local !== null) {
      const version = ++writeVersionRef.current
      persistMemorySetting(user.id, local, version)
    }
  }

  function resetMemories() {
    writeVersionRef.current += 1
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
    if (!user) return
    writeLocalSetting(user.id, enabled)
    const version = ++writeVersionRef.current
    persistMemorySetting(user.id, enabled, version)
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
