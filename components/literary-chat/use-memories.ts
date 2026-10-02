"use client"

import { useRef, useState } from "react"
import type { User } from "@supabase/supabase-js"
import type { Memory } from "@/lib/memory-data"
import {
  deleteMemoryRow,
  fetchMemories,
  fetchProfile,
  insertMemory,
  updateMemory,
} from "@/lib/data"

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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

async function persistMemoryEnabled(enabled: boolean): Promise<void> {
  const response = await fetch('/api/profile/memory', {
    method: 'PUT',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  const body = await response.json().catch(() => ({})) as { enabled?: unknown; error?: unknown }
  if (!response.ok || body.enabled !== enabled) {
    throw new Error(typeof body.error === 'string' ? body.error : '记忆设置保存失败')
  }
}

export function useMemories(user: User | null) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [memoryEnabled, setMemoryEnabledState] = useState(true)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const writeVersionRef = useRef(0)

  function beginMemoryLoad() {
    setMemoryLoading(true)
    setMemoryError(null)
  }

  function failMemoryLoad(error: unknown) {
    setMemoryLoading(false)
    setMemoryError(errorMessage(error, "记忆读取失败，请重试"))
  }

  async function persistMemorySetting(
    userId: string,
    enabled: boolean,
    version: number,
    fallback: boolean,
  ): Promise<boolean> {
    try {
      await persistMemoryEnabled(enabled)
      if (writeVersionRef.current === version) {
        clearLocalSetting(userId)
        setMemoryError(null)
      }
      return true
    } catch (error) {
      if (writeVersionRef.current === version) {
        clearLocalSetting(userId)
        setMemoryEnabledState(fallback)
        setMemoryError(errorMessage(error, "记忆设置保存失败，请重试"))
      }
      return false
    }
  }

  function restoreMemories(items: Memory[], enabled: boolean, useLocalSetting = true) {
    setMemories(items)
    setMemoryLoading(false)
    setMemoryError(null)
    if (!user) {
      setMemoryEnabledState(enabled)
      return
    }
    const local = useLocalSetting ? readLocalSetting(user.id) : null
    const resolved = local ?? enabled
    setMemoryEnabledState(resolved)
    if (local !== null) {
      const version = ++writeVersionRef.current
      void persistMemorySetting(user.id, local, version, enabled)
    }
  }

  function resetMemories() {
    writeVersionRef.current += 1
    setMemories([])
    setMemoryEnabledState(true)
    setMemoryLoading(false)
    setMemoryError(null)
  }

  async function refreshMemories(): Promise<boolean> {
    if (!user) {
      failMemoryLoad(new Error("请先登录后再读取记忆"))
      return false
    }
    beginMemoryLoad()
    const [itemsResult, profileResult] = await Promise.allSettled([
      fetchMemories(),
      fetchProfile(),
    ])
    const items = itemsResult.status === "fulfilled" ? itemsResult.value : []
    const enabled = profileResult.status === "fulfilled" ? profileResult.value.memoryEnabled : false
    restoreMemories(items, enabled, profileResult.status === "fulfilled")
    const failure = itemsResult.status === "rejected"
      ? itemsResult.reason
      : profileResult.status === "rejected" ? profileResult.reason : null
    if (failure) failMemoryLoad(failure)
    return !failure
  }

  async function handleMemoryAdd(content: string): Promise<boolean> {
    if (!user) {
      setMemoryError("请先登录后再保存记忆")
      return false
    }
    try {
      const memory = await insertMemory(user.id, content)
      setMemories(previous => [...previous, memory])
      setMemoryError(null)
      return true
    } catch (error) {
      setMemoryError(errorMessage(error, "记忆保存失败，请重试"))
      return false
    }
  }

  async function handleMemoryEdit(id: string, content: string): Promise<boolean> {
    try {
      await updateMemory(id, content)
      const timestamp = new Date().toISOString()
      setMemories(previous => previous.map(memory => memory.id === id
        ? { ...memory, content, timestamp }
        : memory))
      setMemoryError(null)
      return true
    } catch (error) {
      setMemoryError(errorMessage(error, "记忆修改失败，请重试"))
      return false
    }
  }

  async function handleMemoryDelete(id: string): Promise<boolean> {
    try {
      await deleteMemoryRow(id)
      setMemories(previous => previous.filter(memory => memory.id !== id))
      setMemoryError(null)
      return true
    } catch (error) {
      setMemoryError(errorMessage(error, "记忆删除失败，请重试"))
      return false
    }
  }

  async function handleMemoryEnabledChange(enabled: boolean): Promise<boolean> {
    const previous = memoryEnabled
    setMemoryEnabledState(enabled)
    setMemoryError(null)
    if (!user) {
      setMemoryEnabledState(previous)
      setMemoryError("请先登录后再保存记忆设置")
      return false
    }
    writeLocalSetting(user.id, enabled)
    const version = ++writeVersionRef.current
    return persistMemorySetting(user.id, enabled, version, previous)
  }

  return {
    memories,
    memoryEnabled,
    memoryLoading,
    memoryError,
    setMemories,
    beginMemoryLoad,
    failMemoryLoad,
    restoreMemories,
    resetMemories,
    refreshMemories,
    handleMemoryAdd,
    handleMemoryEdit,
    handleMemoryDelete,
    handleMemoryEnabledChange,
  }
}
