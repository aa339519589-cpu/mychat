"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { ModelCatalogItem } from "@/lib/model-catalog"

type CatalogPayload = { models?: unknown }

function catalogModels(value: unknown): ModelCatalogItem[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as ModelCatalogItem[]
}

function selectable(model: ModelCatalogItem): boolean {
  return model.outputKind === "chat"
    && model.tools
    && (model.access !== "premium" || model.ownerUnlocked === true)
}

function storedEffort(model: ModelCatalogItem): string | null {
  try {
    const saved = localStorage.getItem(`code_reasoning_effort:${model.id}`)
    return saved && model.reasoningEfforts.includes(saved) ? saved : null
  } catch {
    return null
  }
}

function preferredEffort(model: ModelCatalogItem): string | null {
  const saved = storedEffort(model)
  if (saved) return saved
  if (model.defaultReasoningEffort && model.reasoningEfforts.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort
  }
  return model.reasoningEfforts[0] ?? null
}

async function fetchCodeModels(): Promise<ModelCatalogItem[]> {
  const response = await fetch("/api/models", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`catalog ${response.status}`)
  const payload = await response.json() as CatalogPayload
  return catalogModels(payload.models).filter(model => model.outputKind === "chat" && model.tools)
}

export function useCodeModelSelection() {
  const [models, setModels] = useState<ModelCatalogItem[]>([])
  const [activeModelId, setActiveModelId] = useState<string | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null)
  const activeModelIdRef = useRef<string | null>(null)
  activeModelIdRef.current = activeModelId

  const refreshModels = useCallback(async () => {
    try {
      const next = await fetchCodeModels()
      setModels(next)
      const savedCodeModel = localStorage.getItem("code_active_model")
      const savedChatModel = localStorage.getItem("chat_active_model")
      const selected = next.find(model => model.id === activeModelIdRef.current && selectable(model))
        ?? next.find(model => model.id === savedCodeModel && selectable(model))
        ?? next.find(model => model.id === savedChatModel && selectable(model))
        ?? next.find(model => model.access === "quota" && selectable(model))
        ?? next.find(selectable)
        ?? null
      setActiveModelId(selected?.id ?? null)
      setReasoningEffort(selected ? preferredEffort(selected) : null)
      if (selected) localStorage.setItem("code_active_model", selected.id)
    } catch {
      setModels([])
    }
  }, [])

  useEffect(() => {
    try { localStorage.removeItem("code_tier") } catch {}
    void refreshModels()
  }, [refreshModels])

  function selectModel(model: ModelCatalogItem) {
    if (!selectable(model)) return
    const effort = preferredEffort(model)
    setActiveModelId(model.id)
    setReasoningEffort(effort)
    try { localStorage.setItem("code_active_model", model.id) } catch {}
  }

  const activeModel = useMemo(
    () => models.find(model => model.id === activeModelId) ?? null,
    [activeModelId, models],
  )

  function selectReasoningEffort(effort: string) {
    if (!activeModel || !activeModel.reasoningEfforts.includes(effort)) return
    setReasoningEffort(effort)
    try { localStorage.setItem(`code_reasoning_effort:${activeModel.id}`, effort) } catch {}
  }

  return {
    models,
    activeModelId,
    activeModel,
    reasoningEffort,
    selectModel,
    selectReasoningEffort,
    refreshModels,
  }
}
