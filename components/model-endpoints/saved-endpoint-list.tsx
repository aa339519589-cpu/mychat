"use client"

import { Check, Image as ImageIcon, RefreshCw, Server, Trash2, Video } from "lucide-react"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { cn } from "@/lib/utils"
import { endpointHost, outputKindLabel } from "./form-logic"

type SavedEndpointListProps = {
  endpoints: ModelEndpointSummary[]
  activeEndpointId: string | null
  onSelect: (id: string) => void
  onReconnect: (endpoint: ModelEndpointSummary) => void
  onRefresh: (endpoint: ModelEndpointSummary) => void
  onDelete: (id: string) => void
}

function EndpointIcon({ endpoint }: { endpoint: ModelEndpointSummary }) {
  if (endpoint.outputKind === "image") return <ImageIcon className="size-4" />
  if (endpoint.outputKind === "video") return <Video className="size-4" />
  return <Server className="size-4" />
}

export function SavedEndpointList({
  endpoints,
  activeEndpointId,
  onSelect,
  onReconnect,
  onRefresh,
  onDelete,
}: SavedEndpointListProps) {
  return (
    <div className="divide-y divide-sidebar-border/60 border-y border-sidebar-border/60">
      {endpoints.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-muted-foreground">还没有自定义模型</div>
      ) : endpoints.map(endpoint => (
        <div key={endpoint.id} className="group flex min-w-0 items-center gap-2 py-3">
          <button
            type="button"
            onClick={() => endpoint.needsReconnect ? onReconnect(endpoint) : onSelect(endpoint.id)}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-3 text-left",
              endpoint.needsReconnect && "opacity-65",
            )}
            title={endpoint.model}
          >
            <span className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg border",
              activeEndpointId === endpoint.id
                ? "border-sidebar-primary/40 bg-sidebar-primary/10 text-sidebar-primary"
                : "border-sidebar-border text-muted-foreground",
            )}>
              <EndpointIcon endpoint={endpoint} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-foreground">{endpoint.name || endpoint.model}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {endpoint.needsReconnect
                  ? "旧版凭据，请重新连接"
                  : `${outputKindLabel(endpoint.outputKind)} · ${endpointHost(endpoint.baseUrl)}`}
              </span>
            </span>
            {activeEndpointId === endpoint.id && !endpoint.needsReconnect
              ? <Check className="size-4 shrink-0 text-sidebar-primary" />
              : null}
          </button>
          {!endpoint.needsReconnect && (
            <button
              type="button"
              onClick={() => onRefresh(endpoint)}
              aria-label="刷新模型列表"
              title="刷新模型列表"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(endpoint.id)}
            aria-label="删除模型端点"
            title="删除"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
