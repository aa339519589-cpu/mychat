"use client"

import { useState } from "react"
import type { Conversation, Endpoint, MemoryConfig, Protocol } from "@/lib/chat-data"
import { PROTOCOL_LABELS, PROTOCOL_DEFAULTS } from "@/lib/chat-data"
import { cn } from "@/lib/utils"
import { Feather, Plus, Settings, ChevronLeft, Trash2, ChevronDown, ChevronRight } from "lucide-react"

const PROTOCOLS: Protocol[] = ["anthropic", "openai", "gemini"]

type Draft = { name: string; baseUrl: string; apiKey: string; model: string }

function emptyDraft(protocol: Protocol): Draft {
  return {
    name: "",
    baseUrl: PROTOCOL_DEFAULTS[protocol].baseUrl,
    apiKey: "",
    model: PROTOCOL_DEFAULTS[protocol].model,
  }
}

export function ConversationSidebar({
  conversations, activeId, onSelect, onNew,
  endpoints, activeEndpointId, onEndpointsChange, onActiveEndpointChange,
  memoryConfig, onMemoryConfigChange,
}: {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  endpoints: Endpoint[]
  activeEndpointId: string
  onEndpointsChange: (eps: Endpoint[]) => void
  onActiveEndpointChange: (id: string) => void
  memoryConfig: MemoryConfig
  onMemoryConfigChange: (next: MemoryConfig) => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<Protocol, boolean>>({ anthropic: true, openai: true, gemini: false })
  // 每种协议独立的草稿，null 表示未展开添加表单
  const [drafts, setDrafts] = useState<Record<Protocol, Draft | null>>({ anthropic: null, openai: null, gemini: null })

  function setDraft(protocol: Protocol, d: Draft | null) {
    setDrafts(prev => ({ ...prev, [protocol]: d }))
  }

  function updateDraftField(protocol: Protocol, field: keyof Draft, value: string) {
    setDrafts(prev => {
      const cur = prev[protocol]
      if (!cur) return prev
      return { ...prev, [protocol]: { ...cur, [field]: value } }
    })
  }

  function saveEndpoint(protocol: Protocol) {
    const draft = drafts[protocol]
    if (!draft) return
    if (!draft.name.trim()) { alert("请填写名称"); return }
    if (!draft.apiKey.trim()) { alert("请填写 API Key"); return }
    const ep: Endpoint = { id: `ep-${Date.now()}`, protocol, ...draft }
    const next = [...endpoints, ep]
    onEndpointsChange(next)
    if (!activeEndpointId) onActiveEndpointChange(ep.id)
    setDraft(protocol, null)
  }

  function deleteEndpoint(id: string) {
    const next = endpoints.filter(e => e.id !== id)
    onEndpointsChange(next)
    if (activeEndpointId === id) onActiveEndpointChange(next[0]?.id ?? "")
  }

  function updateMemory(field: keyof MemoryConfig, value: string | boolean) {
    onMemoryConfigChange({ ...memoryConfig, [field]: value })
  }

  const memoryReady = memoryConfig.enabled && memoryConfig.baseUrl.trim()

  return (
    <aside className="relative flex h-full w-full flex-col bg-sidebar text-sidebar-foreground overflow-hidden">

      {/* ── 主视图 ── */}
      <div className="flex h-full flex-col">
        <div className="px-7 pb-5 pt-8">
          <div className="flex items-center gap-2.5">
            <Feather className="size-5 text-sidebar-primary" />
            <h1 className="font-heading text-2xl tracking-wide">笺</h1>
          </div>
          <p className="mt-2 text-xs leading-relaxed tracking-wider text-muted-foreground">文字对谈集 · 卷一</p>
        </div>

        <div className="mx-7 mb-4 border-t border-sidebar-border" />

        {/* 当前端点选择 */}
        {memoryReady ? (
          <div className="mx-5 mb-3 rounded-xl border border-sidebar-primary/25 bg-sidebar-primary/10 px-4 py-3">
            <p className="mb-1 text-[11px] tracking-widest text-muted-foreground">当前使用</p>
            <p className="text-sm text-sidebar-primary">记忆系统</p>
            <p className="mt-1 truncate text-[11px] text-muted-foreground">{memoryConfig.model || "ebbingflow"}</p>
          </div>
        ) : endpoints.length > 0 ? (
          <div className="mx-5 mb-3 px-2">
            <p className="mb-1.5 text-[11px] tracking-widest text-muted-foreground">当前使用</p>
            <select
              value={activeEndpointId}
              onChange={e => onActiveEndpointChange(e.target.value)}
              className="w-full rounded-xl border border-sidebar-border bg-background/40 px-3 py-2 text-sm text-foreground outline-none"
            >
              {endpoints.map(ep => (
                <option key={ep.id} value={ep.id}>{ep.name}</option>
              ))}
            </select>
          </div>
        ) : (
          <button
            onClick={() => setSettingsOpen(true)}
            className="mx-5 mb-3 rounded-xl border border-dashed border-sidebar-border px-4 py-3 text-center text-xs italic text-muted-foreground hover:border-sidebar-primary/40 hover:text-sidebar-primary transition-colors"
          >
            点击右下角齿轮配置 API 端点
          </button>
        )}

        <button
          onClick={onNew}
          className="mx-5 mb-4 flex items-center gap-2 rounded-full px-3 py-2 text-sm tracking-wide text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Plus className="size-4" />
          起一篇新的对谈
        </button>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {conversations.map(c => {
            const isActive = c.id === activeId
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={cn("group block w-full rounded-2xl px-4 py-3 text-left transition-colors", isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className={cn("font-heading text-[15px] leading-snug tracking-wide", isActive ? "text-sidebar-primary" : "text-sidebar-foreground")}>{c.title}</span>
                  <span className="shrink-0 text-[11px] tracking-wider text-muted-foreground">{c.date}</span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{c.excerpt}</p>
              </button>
            )
          })}
        </nav>

        <div className="mx-7 border-t border-sidebar-border" />
        <div className="flex items-center justify-between px-7 py-4">
          <p className="text-[11px] italic leading-relaxed tracking-wider text-muted-foreground">「文字是缓慢的，<br />正因如此才值得珍藏。」</p>
          <button
            onClick={() => setSettingsOpen(true)}
            className="ml-3 shrink-0 rounded-full p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
            aria-label="设置"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </div>

      {/* ── 设置面板（滑入覆盖侧边栏） ── */}
      <div className={cn(
        "absolute inset-0 z-10 flex flex-col bg-sidebar transition-transform duration-300",
        settingsOpen ? "translate-x-0" : "translate-x-full",
      )}>
        <div className="flex items-center gap-3 px-6 py-6 shrink-0">
          <button onClick={() => setSettingsOpen(false)} className="rounded-full p-1.5 text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-5" />
          </button>
          <h3 className="font-heading text-lg tracking-wide">API 配置</h3>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-3">
          <p className="px-2 text-[11px] italic text-muted-foreground leading-relaxed">
            Key 存于浏览器本地，发送时由本站后端转发。<br />
            每种协议下可添加多个端点。
          </p>

          <div className="rounded-2xl border border-sidebar-border overflow-hidden">
            <button
              type="button"
              onClick={() => updateMemory("enabled", !memoryConfig.enabled)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-sidebar-accent/40 transition-colors"
            >
              <div>
                <span className="text-sm font-medium tracking-wide">记忆系统</span>
                <p className="mt-1 text-[11px] text-muted-foreground">EbbingFlow / OpenAI 兼容记忆后端</p>
              </div>
              <span className={cn(
                "rounded-full border px-2.5 py-1 text-[11px]",
                memoryConfig.enabled
                  ? "border-sidebar-primary/40 bg-sidebar-primary/10 text-sidebar-primary"
                  : "border-sidebar-border text-muted-foreground",
              )}>
                {memoryConfig.enabled ? "已开启" : "已关闭"}
              </span>
            </button>

            {memoryConfig.enabled && (
              <div className="border-t border-sidebar-border/50 px-3 py-3 space-y-2.5">
                {[
                  { field: "baseUrl" as const, label: "后端地址", placeholder: "https://your-ebbingflow.onrender.com/v1", type: "text" },
                  { field: "apiKey" as const, label: "API Key（可选）", placeholder: "local 或 Bearer token", type: "password" },
                  { field: "model" as const, label: "模型名", placeholder: "ebbingflow", type: "text" },
                  { field: "userId" as const, label: "用户 ID", placeholder: "user_001", type: "text" },
                  { field: "userToken" as const, label: "用户 Token（可选）", placeholder: "用于隔离访问", type: "password" },
                ].map(({ field, label, placeholder, type }) => (
                  <div key={field}>
                    <p className="mb-1 text-[11px] tracking-widest text-muted-foreground">{label}</p>
                    <input
                      type={type}
                      value={String(memoryConfig[field] ?? "")}
                      onChange={e => updateMemory(field, e.target.value)}
                      placeholder={placeholder}
                      className="w-full rounded-lg border border-sidebar-border bg-background/50 px-2.5 py-1.5 text-xs outline-none focus:border-sidebar-primary/50 placeholder:text-muted-foreground/40"
                    />
                  </div>
                ))}
                <p className="px-1 text-[11px] italic leading-relaxed text-muted-foreground">
                  开启后，本轮对话会先交给记忆后端，由它负责长期记忆与模型调用。
                </p>
              </div>
            )}
          </div>

          {PROTOCOLS.map(protocol => (
            <div key={protocol} className="rounded-2xl border border-sidebar-border overflow-hidden">
              <button
                onClick={() => setExpanded(prev => ({ ...prev, [protocol]: !prev[protocol] }))}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-sidebar-accent/40 transition-colors"
              >
                <span className="text-sm font-medium tracking-wide">{PROTOCOL_LABELS[protocol]}</span>
                {expanded[protocol] ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
              </button>

              {expanded[protocol] && (
                <div className="border-t border-sidebar-border/50 px-3 py-2 space-y-2">
                  {/* 已有端点列表 */}
                  {endpoints.filter(e => e.protocol === protocol).map(ep => (
                    <div
                      key={ep.id}
                      onClick={() => onActiveEndpointChange(ep.id)}
                      className={cn(
                        "rounded-xl px-3 py-2.5 flex items-center justify-between gap-2 cursor-pointer transition-colors",
                        activeEndpointId === ep.id ? "bg-sidebar-primary/10 border border-sidebar-primary/30" : "hover:bg-sidebar-accent/50"
                      )}
                    >
                      <div className="min-w-0">
                        <p className="text-sm truncate">{ep.name}</p>
                        <p className="text-[11px] text-muted-foreground truncate">{ep.model}</p>
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); deleteEndpoint(ep.id) }}
                        className="shrink-0 p-1 text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}

                  {/* 添加表单 */}
                  {drafts[protocol] !== null ? (
                    <div className="rounded-xl border border-sidebar-border bg-background/30 p-3 space-y-2.5">
                      {[
                        { field: "name" as const, label: "名称", placeholder: "随便起个名字", type: "text" },
                        { field: "baseUrl" as const, label: "Base URL", placeholder: PROTOCOL_DEFAULTS[protocol].baseUrl, type: "text" },
                        { field: "apiKey" as const, label: "API Key", placeholder: "sk-...", type: "password" },
                        { field: "model" as const, label: "模型名", placeholder: PROTOCOL_DEFAULTS[protocol].model, type: "text" },
                      ].map(({ field, label, placeholder, type }) => (
                        <div key={field}>
                          <p className="mb-1 text-[11px] tracking-widest text-muted-foreground">{label}</p>
                          <input
                            type={type}
                            value={drafts[protocol]?.[field] ?? ""}
                            onChange={e => updateDraftField(protocol, field, e.target.value)}
                            placeholder={placeholder}
                            className="w-full rounded-lg border border-sidebar-border bg-background/50 px-2.5 py-1.5 text-xs outline-none focus:border-sidebar-primary/50 placeholder:text-muted-foreground/40"
                          />
                        </div>
                      ))}
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => saveEndpoint(protocol)}
                          className="flex-1 rounded-lg bg-sidebar-primary px-3 py-1.5 text-xs text-sidebar-primary-foreground hover:opacity-90 transition-opacity"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={() => setDraft(protocol, null)}
                          className="flex-1 rounded-lg border border-sidebar-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDraft(protocol, emptyDraft(protocol))}
                      className="flex w-full items-center gap-1.5 rounded-xl px-3 py-2 text-xs text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground transition-colors"
                    >
                      <Plus className="size-3.5" />添加端点
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
