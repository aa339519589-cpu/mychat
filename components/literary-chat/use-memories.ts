"use client"

import { useRef, useState, type Dispatch, type SetStateAction } from "react"
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

type MemorySetters = {
  setMemories: Dispatch<SetStateAction<Memory[]>>
  setMemoryEnabled: Dispatch<SetStateAction<boolean>>
  setMemoryLoading: Dispatch<SetStateAction<boolean>>
  setMemoryError: Dispatch<SetStateAction<string | null>>
}

type MemoryVersion = { current: number }

async function persistMemorySetting(
  userId: string,
  enabled: boolean,
  version: number,
  fallback: boolean,
  versionRef: MemoryVersion,
  setters: MemorySetters,
): Promise<boolean> {
  try {
    await persistMemoryEnabled(enabled)
    if (versionRef.current === version) {
      clearLocalSetting(userId)
      setters.setMemoryError(null)
    }
    return true
  } catch (error) {
    if (versionRef.current === version) {
      clearLocalSetting(userId)
      setters.setMemoryEnabled(fallback)
      setters.setMemoryError(errorMessage(error, "记忆设置保存失败，请重试"))
    }
    return false
  }
}

type MemoryLoadActions = {
  beginMemoryLoad: () => void
  failMemoryLoad: (error: unknown) => void
  restoreMemories: (items: Memory[], enabled: boolean, useLocalSetting?: boolean) => void
  resetMemories: () => void
  refreshMemories: () => Promise<boolean>
}

function createMemoryLoadActions(
  user: User | null,
  setters: MemorySetters,
  versionRef: MemoryVersion,
): MemoryLoadActions {
  function beginMemoryLoad() {
    setters.setMemoryLoading(true)
    setters.setMemoryError(null)
  }
  function failMemoryLoad(error: unknown) {
    setters.setMemoryLoading(false)
    setters.setMemoryError(errorMessage(error, "记忆读取失败，请重试"))
  }
  function restoreMemories(items: Memory[], enabled: boolean, useLocalSetting = true) {
    setters.setMemories(items)
    setters.setMemoryLoading(false)
    setters.setMemoryError(null)
    if (!user) {
      setters.setMemoryEnabled(enabled)
      return
    }
    const local = useLocalSetting ? readLocalSetting(user.id) : null
    setters.setMemoryEnabled(local ?? enabled)
    if (local !== null) {
      const version = ++versionRef.current
      void persistMemorySetting(user.id, local, version, enabled, versionRef, setters)
    }
  }
  function resetMemories() {
    versionRef.current += 1
    setters.setMemories([])
    setters.setMemoryEnabled(true)
    setters.setMemoryLoading(false)
    setters.setMemoryError(null)
  }
  const actions = { beginMemoryLoad, failMemoryLoad, restoreMemories, resetMemories }
  return { ...actions, refreshMemories: () => refreshMemoryData(user, actions) }
}

async function refreshMemoryData(
  user: User | null,
  actions: Pick<MemoryLoadActions, "beginMemoryLoad" | "failMemoryLoad" | "restoreMemories">,
): Promise<boolean> {
  if (!user) {
    actions.failMemoryLoad(new Error("请先登录后再读取记忆"))
    return false
  }
  actions.beginMemoryLoad()
  const [itemsResult, profileResult] = await Promise.allSettled([fetchMemories(), fetchProfile()])
  const items = itemsResult.status === "fulfilled" ? itemsResult.value : []
  const enabled = profileResult.status === "fulfilled" ? profileResult.value.memoryEnabled : false
  actions.restoreMemories(items, enabled, profileResult.status === "fulfilled")
  const failure = itemsResult.status === "rejected"
    ? itemsResult.reason
    : profileResult.status === "rejected" ? profileResult.reason : null
  if (failure) actions.failMemoryLoad(failure)
  return !failure
}

function createMemoryItemActions(user: User | null, setters: MemorySetters) {
  async function handleMemoryAdd(content: string): Promise<boolean> {
    if (!user) {
      setters.setMemoryError("请先登录后再保存记忆")
      return false
    }
    try {
      const memory = await insertMemory(content)
      setters.setMemories(previous => [...previous, memory])
      setters.setMemoryError(null)
      return true
    } catch (error) {
      setters.setMemoryError(errorMessage(error, "记忆保存失败，请重试"))
      return false
    }
  }
  async function handleMemoryEdit(id: string, content: string): Promise<boolean> {
    try {
      await updateMemory(id, content)
      const timestamp = new Date().toISOString()
      setters.setMemories(previous => previous.map(memory => memory.id === id
        ? { ...memory, content, timestamp }
        : memory))
      setters.setMemoryError(null)
      return true
    } catch (error) {
      setters.setMemoryError(errorMessage(error, "记忆修改失败，请重试"))
      return false
    }
  }
  async function handleMemoryDelete(id: string): Promise<boolean> {
    try {
      await deleteMemoryRow(id)
      setters.setMemories(previous => previous.filter(memory => memory.id !== id))
      setters.setMemoryError(null)
      return true
    } catch (error) {
      setters.setMemoryError(errorMessage(error, "记忆删除失败，请重试"))
      return false
    }
  }
  return { handleMemoryAdd, handleMemoryEdit, handleMemoryDelete }
}

function createMemorySettingAction(
  user: User | null,
  memoryEnabled: boolean,
  setters: MemorySetters,
  versionRef: MemoryVersion,
) {
  return async function handleMemoryEnabledChange(enabled: boolean): Promise<boolean> {
    const previous = memoryEnabled
    setters.setMemoryEnabled(enabled)
    setters.setMemoryError(null)
    if (!user) {
      setters.setMemoryEnabled(previous)
      setters.setMemoryError("请先登录后再保存记忆设置")
      return false
    }
    writeLocalSetting(user.id, enabled)
    const version = ++versionRef.current
    return persistMemorySetting(user.id, enabled, version, previous, versionRef, setters)
  }
}

export function useMemories(user: User | null) {
  const [memories, setMemories] = useState<Memory[]>([])
  const [memoryEnabled, setMemoryEnabled] = useState(true)
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryError, setMemoryError] = useState<string | null>(null)
  const versionRef = useRef(0)
  const setters = { setMemories, setMemoryEnabled, setMemoryLoading, setMemoryError }
  const loading = createMemoryLoadActions(user, setters, versionRef)
  const items = createMemoryItemActions(user, setters)
  const handleMemoryEnabledChange = createMemorySettingAction(user, memoryEnabled, setters, versionRef)
  return {
    memories,
    memoryEnabled,
    memoryLoading,
    memoryError,
    setMemories,
    ...loading,
    ...items,
    handleMemoryEnabledChange,
  }
}
