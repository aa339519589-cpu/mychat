"use client"

import { useMemo, useState, type Dispatch, type SetStateAction } from "react"
import { TIERS, type Tier } from "@/lib/chat-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import type { SearchMode } from "@/lib/search-mode"

type UseModelSelectionOptions = {
  setSearchMode: Dispatch<SetStateAction<SearchMode>>
  setDeepResearch: Dispatch<SetStateAction<boolean>>
  setHistoryRetrieval: Dispatch<SetStateAction<boolean>>
}

export function useModelSelection(options: UseModelSelectionOptions) {
  const { setSearchMode, setDeepResearch, setHistoryRetrieval } = options
  const [activeTier, setActiveTier] = useState<Tier>("绝句")
  const [modelEndpoints, setModelEndpoints] = useState<ModelEndpointSummary[]>([])
  const [activeEndpointId, setActiveEndpointId] = useState<string | null>(null)

  function restoreModelSelection(endpoints: ModelEndpointSummary[]) {
    setModelEndpoints(endpoints)
    try {
      const selection = JSON.parse(localStorage.getItem("chat_model_selection") ?? "null") as {
        kind?: string
        id?: string
        tier?: Tier
      } | null
      if (selection?.kind === "custom" && endpoints.some(endpoint => endpoint.id === selection.id && !endpoint.needsReconnect)) {
        setActiveEndpointId(selection.id ?? null)
      } else {
        setActiveEndpointId(null)
      }
      const savedTier = localStorage.getItem("chat_active_tier") as Tier | null
      const selectedTier = selection?.kind === "builtin" ? selection.tier : savedTier
      if (selectedTier && TIERS.some(tier => tier.id === selectedTier)) setActiveTier(selectedTier)
    } catch {}
  }

  function resetModelEndpoints() {
    setModelEndpoints([])
    setActiveEndpointId(null)
  }

  function handleTierChange(tier: Tier) {
    setActiveTier(tier)
    setActiveEndpointId(null)
    if (tier === "绘影" || tier === "录像") {
      setSearchMode("off")
      setDeepResearch(false)
      setHistoryRetrieval(false)
    }
    try {
      localStorage.setItem("chat_active_tier", tier)
      localStorage.setItem("chat_model_selection", JSON.stringify({ kind: "builtin", tier }))
    } catch {}
  }

  function activateEndpoint(endpoint: ModelEndpointSummary) {
    setActiveEndpointId(endpoint.id)
    setSearchMode("off")
    if (endpoint.outputKind !== "chat") {
      setDeepResearch(false)
      setHistoryRetrieval(false)
    }
    try {
      localStorage.setItem("chat_model_selection", JSON.stringify({ kind: "custom", id: endpoint.id }))
    } catch {}
  }

  function handleEndpointSelect(id: string) {
    const endpoint = modelEndpoints.find(item => item.id === id && !item.needsReconnect)
    if (endpoint) activateEndpoint(endpoint)
  }

  function handleEndpointCreated(endpoint: ModelEndpointSummary) {
    setModelEndpoints(previous => [endpoint, ...previous.filter(item => item.id !== endpoint.id)])
    activateEndpoint(endpoint)
  }

  function handleEndpointUpdated(endpoint: ModelEndpointSummary) {
    setModelEndpoints(previous => previous.map(item => item.id === endpoint.id ? endpoint : item))
    activateEndpoint(endpoint)
  }

  function handleEndpointDeleted(id: string) {
    setModelEndpoints(previous => previous.filter(item => item.id !== id))
    if (activeEndpointId === id) handleTierChange(activeTier)
  }

  const activeEndpoint = useMemo(
    () => modelEndpoints.find(endpoint => endpoint.id === activeEndpointId && !endpoint.needsReconnect) ?? null,
    [modelEndpoints, activeEndpointId],
  )

  return {
    activeTier,
    modelEndpoints,
    activeEndpointId,
    activeEndpoint,
    restoreModelSelection,
    resetModelEndpoints,
    handleTierChange,
    handleEndpointSelect,
    handleEndpointCreated,
    handleEndpointUpdated,
    handleEndpointDeleted,
  }
}
