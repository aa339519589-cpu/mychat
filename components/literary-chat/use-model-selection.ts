"use client"

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react"
import type { Tier } from "@/lib/chat-data"
import type { ModelCatalogItem } from "@/lib/model-catalog"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import type { SearchMode } from "@/lib/search-mode"

type UseModelSelectionOptions = {
  setSearchMode: Dispatch<SetStateAction<SearchMode>>
  setHistoryRetrieval: Dispatch<SetStateAction<boolean>>
  setRenderEnabled: Dispatch<SetStateAction<boolean>>
}

type CatalogPayload = {
  models?: unknown
}

const MODEL_QUOTA_CHANGED_EVENT = "mychat:model-quota-changed"
const CUSTOM_REASONING_STORAGE_PREFIX = "chat_custom_reasoning_effort:"

function modelList(value: unknown): ModelCatalogItem[] {
  if (!Array.isArray(value)) return []
  return value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as ModelCatalogItem[]
}

async function fetchCatalog(): Promise<ModelCatalogItem[]> {
  const response = await fetch("/api/models", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`catalog ${response.status}`)
  const payload = await response.json() as CatalogPayload
  return modelList(payload.models)
}

function isSelectable(model: ModelCatalogItem): boolean {
  if (model.access === "quota") return true
  return model.ownerUnlocked === true
    || model.trialUnlimited === true
    || model.trialSelectable === true
}

function preferredEffort(model: ModelCatalogItem, saved?: string | null): string | null {
  if (saved && model.reasoningEfforts.includes(saved)) return saved
  if (!model.reasoningMandatory && model.reasoningEfforts.includes("none")) return "none"
  if (model.defaultReasoningEffort && model.reasoningEfforts.includes(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort
  }
  return model.reasoningEfforts[0] ?? null
}

function customReasoningStorageKey(endpointId: string): string {
  return `${CUSTOM_REASONING_STORAGE_PREFIX}${endpointId}`
}

function endpointSupportsReasoning(endpoint: ModelEndpointSummary, effort: string): boolean {
  const options: readonly string[] = endpoint.reasoningEfforts
  return options.includes(effort)
}

function savedCustomReasoningEffort(endpoint: ModelEndpointSummary): string | null {
  try {
    const saved = localStorage.getItem(customReasoningStorageKey(endpoint.id))
    return saved && endpointSupportsReasoning(endpoint, saved) ? saved : null
  } catch {
    return null
  }
}

function preferredEndpointEffort(endpoint: ModelEndpointSummary, saved?: string | null): string | null {
  if (endpoint.outputKind !== "chat" || endpoint.reasoningEfforts.length === 0) return null
  if (saved && endpointSupportsReasoning(endpoint, saved)) return saved
  if (!endpoint.reasoningMandatory && endpointSupportsReasoning(endpoint, "none")) return "none"
  if (endpoint.defaultReasoningEffort && endpointSupportsReasoning(endpoint, endpoint.defaultReasoningEffort)) {
    return endpoint.defaultReasoningEffort
  }
  return endpoint.reasoningEfforts[0] ?? null
}

export function useModelSelection(options: UseModelSelectionOptions) {
  const { setSearchMode, setHistoryRetrieval, setRenderEnabled } = options
  const [activeTier, setActiveTier] = useState<Tier>("绝句")
  const [modelEndpoints, setModelEndpoints] = useState<ModelEndpointSummary[]>([])
  const [activeEndpointId, setActiveEndpointId] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<ModelCatalogItem[]>([])
  const [activeModelId, setActiveModelId] = useState<string | null>(null)
  const [reasoningEffort, setReasoningEffortState] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchCatalog()
      .then(models => {
        if (cancelled) return
        setCatalog(models)
        const savedId = localStorage.getItem("chat_active_model")
        const selected = models.find(model => model.id === savedId && isSelectable(model))
          ?? models.find(model => model.access === "quota")
          ?? models.find(isSelectable)
          ?? null
        setActiveModelId(selected?.id ?? null)
        const savedEffort = localStorage.getItem("chat_reasoning_effort")
        const usableSaved = savedEffort === "none" || savedEffort === "minimal" || savedEffort === "low"
          ? savedEffort
          : null
        setReasoningEffortState(selected ? preferredEffort(selected, usableSaved) : null)
      })
      .catch(() => {
        if (!cancelled) setCatalog([])
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    const refreshQuota = () => {
      void fetchCatalog()
        .then(models => { if (!cancelled) setCatalog(models) })
        .catch(() => undefined)
    }
    window.addEventListener(MODEL_QUOTA_CHANGED_EVENT, refreshQuota)
    return () => {
      cancelled = true
      window.removeEventListener(MODEL_QUOTA_CHANGED_EVENT, refreshQuota)
    }
  }, [])

  function restoreModelSelection(endpoints: ModelEndpointSummary[]) {
    setModelEndpoints(endpoints)
    setActiveEndpointId(null)
  }

  function resetModelEndpoints() {
    setModelEndpoints([])
    setActiveEndpointId(null)
    setCatalog([])
    setActiveModelId(null)
    setReasoningEffortState(null)
  }

  function handleTierChange(tier: Tier) {
    setActiveTier(tier)
    setActiveEndpointId(null)
  }

  function handleModelSelect(model: ModelCatalogItem) {
    if (!isSelectable(model)) return
    setActiveModelId(model.id)
    setActiveEndpointId(null)
    setSearchMode("off")
    setHistoryRetrieval(false)
    setRenderEnabled(false)
    const nextEffort = preferredEffort(model)
    setReasoningEffortState(nextEffort)
    try {
      localStorage.setItem("chat_active_model", model.id)
      if (nextEffort) localStorage.setItem("chat_reasoning_effort", nextEffort)
      else localStorage.removeItem("chat_reasoning_effort")
    } catch {}
  }

  function setReasoningEffort(value: string) {
    if (activeEndpointId) {
      const endpoint = modelEndpoints.find(item => item.id === activeEndpointId)
      if (!endpoint || endpoint.outputKind !== "chat" || !endpointSupportsReasoning(endpoint, value)) return
      setReasoningEffortState(value)
      try { localStorage.setItem(customReasoningStorageKey(endpoint.id), value) } catch {}
      return
    }
    const model = catalog.find(item => item.id === activeModelId)
    if (!model || !model.reasoningEfforts.includes(value)) return
    setReasoningEffortState(value)
    try { localStorage.setItem("chat_reasoning_effort", value) } catch {}
  }

  function handleEndpointSelect(id: string) {
    const endpoint = modelEndpoints.find(item => item.id === id)
    if (!endpoint || endpoint.needsReconnect) return
    setActiveEndpointId(id)
    setSearchMode("off")
    setHistoryRetrieval(false)
    setRenderEnabled(false)
    setReasoningEffortState(preferredEndpointEffort(endpoint, savedCustomReasoningEffort(endpoint)))
  }
  function handleEndpointCreated(endpoint: ModelEndpointSummary) {
    setModelEndpoints(previous => [endpoint, ...previous.filter(item => item.id !== endpoint.id)])
  }
  function handleEndpointUpdated(endpoint: ModelEndpointSummary) {
    setModelEndpoints(previous => previous.map(item => item.id === endpoint.id ? endpoint : item))
    if (activeEndpointId === endpoint.id) {
      const retained = reasoningEffort && endpointSupportsReasoning(endpoint, reasoningEffort)
        ? reasoningEffort
        : savedCustomReasoningEffort(endpoint)
      setReasoningEffortState(preferredEndpointEffort(endpoint, retained))
    }
  }
  function handleEndpointDeleted(id: string) {
    setModelEndpoints(previous => previous.filter(item => item.id !== id))
    try { localStorage.removeItem(customReasoningStorageKey(id)) } catch {}
    if (activeEndpointId === id) {
      setActiveEndpointId(null)
      setReasoningEffortState(null)
    }
  }

  const activeModel = useMemo(
    () => catalog.find(model => model.id === activeModelId) ?? null,
    [activeModelId, catalog],
  )
  const activeEndpoint = useMemo(
    () => modelEndpoints.find(endpoint => endpoint.id === activeEndpointId) ?? null,
    [activeEndpointId, modelEndpoints],
  )

  return {
    activeTier,
    modelEndpoints,
    activeEndpointId,
    activeEndpoint,
    catalog,
    activeModelId,
    activeModel,
    reasoningEffort,
    restoreModelSelection,
    resetModelEndpoints,
    handleTierChange,
    handleModelSelect,
    setReasoningEffort,
    handleEndpointSelect,
    handleEndpointCreated,
    handleEndpointUpdated,
    handleEndpointDeleted,
  }
}
