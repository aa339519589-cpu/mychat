"use client"

import { Image as ImageIcon, Loader2, MessageCircle, RefreshCw, Server, Video } from "lucide-react"
import {
  type DiscoveredModel,
  type EndpointAuthType,
  type ModelOutputKind,
} from "@/lib/model-endpoints"
import { cn } from "@/lib/utils"
import { discoveredModelLabel, type EndpointFormPhase } from "./form-logic"

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

type ModelSelectionFieldsProps = {
  models: DiscoveredModel[]
  selectedModel: string
  manualModel: string
  outputKind: ModelOutputKind
  authType: EndpointAuthType | "auto"
  phase: EndpointFormPhase
  discoverDisabled: boolean
  showAuth: boolean
  onDiscover: () => void
  onSelectedModelChange: (value: string) => void
  onManualModelChange: (value: string) => void
  onOutputKindChange: (value: ModelOutputKind) => void
  onAuthTypeChange: (value: EndpointAuthType | "auto") => void
}

export function ModelSelectionFields({
  models,
  selectedModel,
  manualModel,
  outputKind,
  authType,
  phase,
  discoverDisabled,
  showAuth,
  onDiscover,
  onSelectedModelChange,
  onManualModelChange,
  onOutputKindChange,
  onAuthTypeChange,
}: ModelSelectionFieldsProps) {
  return (
    <>
      <button
        type="button"
        onClick={onDiscover}
        disabled={discoverDisabled}
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
            onChange={event => onSelectedModelChange(event.target.value)}
            className="block w-full min-w-0 truncate rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] text-foreground outline-none focus:border-sidebar-primary/50"
            title={selectedModel}
          >
            {models.map(model => (
              <option key={model.id} value={model.id}>{discoveredModelLabel(model)}</option>
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
                onClick={() => onOutputKindChange(option.value)}
                aria-pressed={outputKind === option.value}
                className={cn(
                  "flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors",
                  outputKind === option.value
                    ? "bg-sidebar-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground",
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
          {showAuth && (
            <label className="block">
              <span className="mb-1.5 block text-[11px] text-muted-foreground">鉴权方式</span>
              <select
                value={authType}
                onChange={event => onAuthTypeChange(event.target.value as EndpointAuthType | "auto")}
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
              onChange={event => onManualModelChange(event.target.value)}
              placeholder="仅在服务不支持 /models 时使用"
              className="w-full rounded-lg border border-sidebar-border bg-background/45 px-3 py-2 text-[13px] outline-none focus:border-sidebar-primary/50"
            />
          </label>
        </div>
      </details>
    </>
  )
}
