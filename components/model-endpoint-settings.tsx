"use client"

import { useRef, useState } from "react"
import { Check, Image as ImageIcon, KeyRound, Link2, Loader2, MessageCircle, Plus, RefreshCw, Server, Trash2, Video, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  createModelEndpoint,
  deleteModelEndpoint,
  discoverModels,
  updateModelEndpoint,
} from "@/lib/data"
import { modelOutputKind, type DiscoveredModel, type EndpointAuthType, type ModelEndpointSummary, type ModelOutputKind } from "@/lib/model-endpoints"

type Phase = "idle" | "discovering" | "testing" | "error" | "success"

type Props = {
  endpoints: ModelEndpointSummary[]
  activeEndpointId: string | null
  onSelect: (id: string) => void
  onCreated: (endpoint: ModelEndpointSummary) => void
  onUpdated: (endpoint: ModelEndpointSummary) => void
  onDeleted: (id: string) => void
}

const AUTH_OPTIONS: { value: EndpointAuthType | "auto"; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "bearer", label: "Bearer" },
  { value: "x-api-key", label: "x-api-key" },
  { value: "api-key", label: "api-key" },
  { value: "none", label: "无鉴权" },
]

const OUTPUT_KIND_OPTIONS: { value: ModelOutputKind; label: string; icon: typeof Server }[] = [
  { value: "chat", label: "对话", icon: MessageCircle },
  { value: "image", label: "图片", icon: ImageIcon },
  { value: "video", label: "视频", icon: Video },
]

function endpointHost(baseUrl: string): string {
  try { return new URL(baseUrl).host } catch { return baseUrl }
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
  const [phase, setPhase] = useState<Phase>("idle")
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
      const next = result.models.find(model => model.id === current)?.id
        ?? result.models.find(model => model.chatCompatible)?.id
        ?? result.models[0]?.id
        ?? ""
      setSelectedModel(next)
      setManualModel("")
      setOutputKind(endpoint?.outputKind ?? (reconnecting ? outputKind : modelOutputKind(next)))
      setPhase("success")
      const chatCount = result.models.filter(model => model.chatCompatible).length
      const imageCount = result.models.filter(model => modelOutputKind(model.id) === "image").length
      const videoCount = result.models.filter(model => modelOutputKind(model.id) === "video").length
      setMessage(`已获取 ${result.models.length} 个模型。名称建议：${chatCount} 个对话、${imageCount} 个图片、${videoCount} 个视频`)
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
      setNotice(outputKind === "chat"
        ? "对话模型已通过生成验证并连接。"
        : `${outputKind === "image" ? "图片" : "视频"}模型配置已保存；生成接口将在首次生成时验证，可能产生服务商费用。`)
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
      <div className="divide-y divide-sidebar-border/60 border-y border-sidebar-border/60">
        {endpoints.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-muted-foreground">还没有自定义模型</div>
        ) : endpoints.map(endpoint => (
          <div key={endpoint.id} className="group flex min-w-0 items-center gap-2 py-3">
            <button
              type="button"
              onClick={() => endpoint.needsReconnect ? openReconnect(endpoint) : onSelect(endpoint.id)}
              className={cn(
                "flex min-w-0 flex-1 items-center gap-3 text-left",
                endpoint.needsReconnect && "opacity-65",
              )}
              title={endpoint.model}
            >
              <span className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                activeEndpointId === endpoint.id ? "border-sidebar-primary/40 bg-sidebar-primary/10 text-sidebar-primary" : "border-sidebar-border text-muted-foreground",
              )}>
                {endpoint.outputKind === "image" ? <ImageIcon className="size-4" /> : endpoint.outputKind === "video" ? <Video className="size-4" /> : <Server className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">{endpoint.name || endpoint.model}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {endpoint.needsReconnect ? "旧版凭据，请重新连接" : `${endpoint.outputKind === "image" ? "图片" : endpoint.outputKind === "video" ? "视频" : "对话"} · ${endpointHost(endpoint.baseUrl)}`}
                </span>
              </span>
              {activeEndpointId === endpoint.id && !endpoint.needsReconnect ? <Check className="size-4 shrink-0 text-sidebar-primary" /> : null}
            </button>
            {!endpoint.needsReconnect && (
              <button
                type="button"
                onClick={() => handleDiscover(endpoint)}
                aria-label="刷新模型列表"
                title="刷新模型列表"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              >
                <RefreshCw className="size-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => handleDelete(endpoint.id)}
              aria-label="删除模型端点"
              title="删除"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

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
            <>
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Link2 className="size-3.5" />Base URL</span>
                <input
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={baseUrl}
                  onChange={event => { setBaseUrl(event.target.value); setMessage(""); setPhase("idle") }}
                  placeholder="https://api.example.com/v1"
                  className="w-full rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] outline-none transition-colors focus:border-sidebar-primary/50"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"><KeyRound className="size-3.5" />API Key</span>
                <input
                  type="password"
                  name="model-api-key"
                  autoComplete="new-password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={apiKey}
                  onChange={event => { setApiKey(event.target.value); setMessage(""); setPhase("idle") }}
                  placeholder="可留空"
                  className="w-full rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] outline-none transition-colors focus:border-sidebar-primary/50"
                />
              </label>
            </>
          )}

          <button
            type="button"
            onClick={() => handleDiscover(editingId && !reconnecting ? endpoints.find(endpoint => endpoint.id === editingId) : undefined)}
            disabled={phase === "discovering" || ((!editingId || reconnecting) && !baseUrl.trim())}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-sidebar-border px-3 py-2 text-[13px] text-foreground transition-colors hover:bg-sidebar-accent/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {phase === "discovering" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {phase === "discovering" ? "正在获取模型" : "获取模型"}
          </button>

          {models.length > 0 && (
            <label className="block min-w-0">
              <span className="mb-1.5 block text-[11px] text-muted-foreground">模型</span>
              <select
                value={selectedModel}
                onChange={event => {
                  setSelectedModel(event.target.value)
                  setManualModel("")
                  setOutputKind(modelOutputKind(event.target.value))
                }}
                className="block w-full min-w-0 truncate rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] text-foreground outline-none focus:border-sidebar-primary/50"
                title={selectedModel}
              >
                {models.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}{model.displayName !== model.id ? ` · ${model.id}` : ""}{modelOutputKind(model.id) === "image" ? " · 建议：图片" : modelOutputKind(model.id) === "video" ? " · 建议：视频" : !model.chatCompatible ? " · 建议：对话（需确认）" : " · 建议：对话"}
                  </option>
                ))}
              </select>
            </label>
          )}

          <fieldset>
            <legend className="mb-1.5 block text-[11px] text-muted-foreground">用途</legend>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-sidebar-border bg-background/30 p-1">
              {OUTPUT_KIND_OPTIONS.map(option => {
                const Icon = option.icon
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setOutputKind(option.value)}
                    aria-pressed={outputKind === option.value}
                    className={cn(
                      "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors",
                      outputKind === option.value ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{option.label}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          <details className="border-t border-sidebar-border/50 pt-2">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">高级设置</summary>
            <div className="mt-3 space-y-3">
              {(!editingId || reconnecting) && (
                <label className="block">
                  <span className="mb-1.5 block text-[11px] text-muted-foreground">鉴权方式</span>
                  <select
                    value={authType}
                    onChange={event => setAuthType(event.target.value as EndpointAuthType | "auto")}
                    className="w-full rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] outline-none"
                  >
                    {AUTH_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              )}
              <label className="block">
                <span className="mb-1.5 block text-[11px] text-muted-foreground">手动模型 ID</span>
                <input
                  type="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={manualModel}
                  onChange={event => {
                    setManualModel(event.target.value)
                    if (event.target.value) {
                      setSelectedModel("")
                      setOutputKind(modelOutputKind(event.target.value))
                    }
                  }}
                  placeholder="仅在服务不支持 /models 时使用"
                  className="w-full rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] outline-none focus:border-sidebar-primary/50"
                />
              </label>
            </div>
          </details>

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
