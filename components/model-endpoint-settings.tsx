"use client"

import { useRef, useState } from "react"
import { Check, Loader2, Plus, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  createModelEndpoint,
  deleteModelEndpoint,
  discoverModels,
  updateModelEndpoint,
} from "@/lib/data"
import { modelOutputKind, type DiscoveredModel, type EndpointAuthType, type ModelEndpointSummary, type ModelOutputKind } from "@/lib/model-endpoints"
import { ConnectionFields } from "@/components/model-endpoints/connection-fields"
import {
  discoverySummary,
  savedEndpointNotice,
  selectDiscoveredModel,
  type EndpointFormPhase,
} from "@/components/model-endpoints/form-logic"
import { ModelSelectionFields } from "@/components/model-endpoints/model-selection-fields"
import { SavedEndpointList } from "@/components/model-endpoints/saved-endpoint-list"

type Props = {
  endpoints: ModelEndpointSummary[]
  activeEndpointId: string | null
  onSelect: (id: string) => void
  onCreated: (endpoint: ModelEndpointSummary) => void
  onUpdated: (endpoint: ModelEndpointSummary) => void
  onDeleted: (id: string) => void
}

export function ModelEndpointSettings({
  endpoints, activeEndpointId, onSelect, onCreated, onUpdated, onDeleted,
}: Props) {
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [authType, setAuthType] = useState<EndpointAuthType | "auto">("auto")
  const [models, setModels] = useState<DiscoveredModel[]>([])
  const [selectedModel, setSelectedModel] = useState("")
  const [manualModel, setManualModel] = useState("")
  const [outputKind, setOutputKind] = useState<ModelOutputKind>("chat")
  const [phase, setPhase] = useState<EndpointFormPhase>("idle")
  const [message, setMessage] = useState("")
  const [notice, setNotice] = useState("")
  const discoverRequestRef = useRef(0)

  const effectiveModel = selectedModel || manualModel.trim()

  function resetForm(clearNotice = true) {
    discoverRequestRef.current += 1
    setFormOpen(false)
    setEditingId(null)
    setReconnecting(false)
    setBaseUrl("")
    setApiKey("")
    setAuthType("auto")
    setModels([])
    setSelectedModel("")
    setManualModel("")
    setOutputKind("chat")
    setPhase("idle")
    setMessage("")
    if (clearNotice) setNotice("")
  }

  function openNew() {
    resetForm()
    setFormOpen(true)
  }

  function openReconnect(endpoint: ModelEndpointSummary) {
    resetForm()
    setFormOpen(true)
    setEditingId(endpoint.id)
    setReconnecting(true)
    setBaseUrl(endpoint.baseUrl)
    setAuthType("auto")
    setManualModel(endpoint.model)
    setOutputKind(endpoint.outputKind)
  }

  async function handleDiscover(endpoint?: ModelEndpointSummary) {
    const requestId = ++discoverRequestRef.current
    setPhase("discovering")
    setMessage("")
    if (endpoint) {
      setFormOpen(true)
      setEditingId(endpoint.id)
      setReconnecting(false)
      setBaseUrl(endpoint.baseUrl)
      setApiKey("")
      setAuthType(endpoint.authType)
      setModels([])
      setSelectedModel(endpoint.model)
      setManualModel("")
      setOutputKind(endpoint.outputKind)
    }
    try {
      const result = await discoverModels(endpoint
        ? { endpointId: endpoint.id }
        : { baseUrl: baseUrl.trim(), apiKey, authType })
      if (requestId !== discoverRequestRef.current) return
      setBaseUrl(result.baseUrl)
      setAuthType(current => current === "auto" ? "auto" : result.authType)
      setModels(result.models)
      const current = endpoint?.model || selectedModel || manualModel.trim()
      const next = selectDiscoveredModel(result.models, current)
      setSelectedModel(next)
      setManualModel("")
      setOutputKind(endpoint?.outputKind ?? (reconnecting ? outputKind : modelOutputKind(next)))
      setPhase("success")
      setMessage(discoverySummary(result.models))
    } catch (error) {
      if (requestId !== discoverRequestRef.current) return
      setPhase("error")
      setMessage(error instanceof Error ? error.message : "获取模型失败")
    }
  }

  async function handleSave() {
    if (!effectiveModel) return
    setPhase("testing")
    setMessage("")
    const discovered = models.find(model => model.id === effectiveModel)
    try {
      if (editingId) {
        const endpoint = await updateModelEndpoint(editingId, {
          model: effectiveModel,
          outputKind,
          displayName: discovered?.displayName,
          ...(reconnecting ? {
            baseUrl: baseUrl.trim(),
            apiKey,
            authType,
          } : authType !== "auto" ? { authType } : {}),
        })
        onUpdated(endpoint)
      } else {
        if (!baseUrl.trim()) throw new Error("请填写 Base URL")
        const endpoint = await createModelEndpoint({
          baseUrl: baseUrl.trim(),
          apiKey,
          authType,
          model: effectiveModel,
          outputKind,
          displayName: discovered?.displayName,
        })
        onCreated(endpoint)
      }
      resetForm(false)
      setNotice(savedEndpointNotice(outputKind))
    } catch (error) {
      setPhase("error")
      setMessage(error instanceof Error ? error.message : "连接验证失败")
    }
  }

  async function handleDelete(id: string) {
    setMessage("")
    try {
      await deleteModelEndpoint(id)
      onDeleted(id)
      if (editingId === id) resetForm()
    } catch (error) {
      setPhase("error")
      setMessage(error instanceof Error ? error.message : "删除失败")
    }
  }

  return (
    <div className="px-4 pb-6">
      <SavedEndpointList
        endpoints={endpoints}
        activeEndpointId={activeEndpointId}
        onSelect={onSelect}
        onReconnect={openReconnect}
        onRefresh={handleDiscover}
        onDelete={handleDelete}
      />

      {notice && <p className="mt-3 break-words text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{notice}</p>}

      {!formOpen ? (
        <button
          type="button"
          onClick={openNew}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg border border-sidebar-border px-3 py-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
        >
          <Plus className="size-4" />连接模型服务
        </button>
      ) : (
        <div className="mt-4 space-y-3 border-t border-sidebar-border/60 pt-4">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-foreground">
              {reconnecting ? "重新连接模型服务" : editingId ? "切换端点模型" : "连接模型服务"}
            </span>
            <button type="button" onClick={() => resetForm()} aria-label="关闭" className="rounded-md p-1 text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>

          {(!editingId || reconnecting) && (
            <ConnectionFields
              baseUrl={baseUrl}
              apiKey={apiKey}
              onBaseUrlChange={value => { setBaseUrl(value); setMessage(""); setPhase("idle") }}
              onApiKeyChange={value => { setApiKey(value); setMessage(""); setPhase("idle") }}
            />
          )}

          <ModelSelectionFields
            models={models}
            selectedModel={selectedModel}
            manualModel={manualModel}
            outputKind={outputKind}
            authType={authType}
            phase={phase}
            discoverDisabled={phase === "discovering" || ((!editingId || reconnecting) && !baseUrl.trim())}
            showAuth={!editingId || reconnecting}
            onDiscover={() => handleDiscover(editingId && !reconnecting
              ? endpoints.find(endpoint => endpoint.id === editingId)
              : undefined)}
            onSelectedModelChange={value => {
              setSelectedModel(value)
              setManualModel("")
              setOutputKind(modelOutputKind(value))
            }}
            onManualModelChange={value => {
              setManualModel(value)
              if (value) {
                setSelectedModel("")
                setOutputKind(modelOutputKind(value))
              }
            }}
            onOutputKindChange={setOutputKind}
            onAuthTypeChange={setAuthType}
          />

          {message && (
            <p className={cn("break-words text-[11px] leading-relaxed [overflow-wrap:anywhere]", phase === "error" ? "text-destructive" : "text-muted-foreground")}>
              {message}
            </p>
          )}

          <button
            type="button"
            onClick={handleSave}
            disabled={!effectiveModel || phase === "testing" || phase === "discovering"}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-sidebar-primary px-3 py-2.5 text-[13px] text-sidebar-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === "testing" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            {phase === "testing"
              ? outputKind === "chat" ? "正在验证对话生成" : "正在验证服务连接"
              : reconnecting ? "连接并更新" : editingId ? "连接并切换" : "连接服务"}
          </button>
        </div>
      )}
    </div>
  )
}
