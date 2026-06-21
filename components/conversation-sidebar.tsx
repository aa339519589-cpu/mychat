"use client"

import { useState } from "react"
import type { Conversation, Endpoint, Protocol } from "@/lib/chat-data"
import { PROTOCOL_LABELS, PROTOCOL_DEFAULTS } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import { saveMemories } from "@/lib/memory-data"
import { cn } from "@/lib/utils"
import { Feather, Plus, Settings, ChevronLeft, Trash2, ChevronDown, ChevronRight, Brain } from "lucide-react"

const PROTOCOLS: Protocol[] = ["anthropic", "openai", "gemini"]

const OPENAI_PRESETS = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { label: "OpenAI", baseUrl: "https://api.openai.com", model: "gpt-4o-mini" },
] as const

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
  conversations, activeId, onSelect, onNew, onDelete,
  endpoints, activeEndpointId, onEndpointsChange, onActiveEndpointChange,
  memories, onMemoriesChange,
}: {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  endpoints: Endpoint[]
  activeEndpointId: string
  onEndpointsChange: (eps: Endpoint[]) => void
  onActiveEndpointChange: (id: string) => void
  memories: Memory[]
  onMemoriesChange: (mems: Memory[]) => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expanded, setExpanded] = useState<Record<Protocol, boolean>>({ anthropic: false, openai: true, gemini: false })
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
    if (!draft.baseUrl.trim()) { alert("请填写服务地址"); return }
    if (!draft.model.trim()) { alert("请填写模型名"); return }
    const ep: Endpoint = {
      id: `ep-${Date.now()}`,
      protocol,
      name: draft.name.trim(),
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      model: draft.model.trim(),
    }
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

  function applyOpenAIPreset(preset: (typeof OPENAI_PRESETS)[number]) {
    setDrafts(prev => {
      const current = prev.openai
      if (!current) return prev
      return {
        ...prev,
        openai: {
          ...current,
          name: preset.label,
          baseUrl: preset.baseUrl,
          model: preset.model,
        },
      }
    })
  }

  return (
    <aside className="relative flex h-full w-full flex-col bg-sidebar text-sidebar-foreground overflow-hidden">

      {/* ── 主视图 ── */}
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <Feather className="size-4 text-sidebar-primary" />
          <span className="font-heading text-base tracking-wide text-sidebar-foreground">笺</span>
        </div>

        {endpoints.length === 0 && (
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
              <div key={c.id} className="group relative">
                <button
                  onClick={() => onSelect(c.id)}
                  className={cn("block w-full rounded-2xl px-4 py-3 text-left transition-colors pr-9", isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={cn("font-heading text-[15px] leading-snug tracking-wide", isActive ? "text-sidebar-primary" : "text-sidebar-foreground")}>{c.title}</span>
                    <span className="shrink-0 text-[11px] tracking-wider text-muted-foreground">{c.date}</span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{c.excerpt}</p>
                </button>
                <button
                  onClick={e => { e.stopPropagation(); onDelete(c.id) }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sidebar-accent hover:text-foreground"
                  aria-label="删除对话"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )
          })}
        </nav>

        <div className="mx-7 border-t border-sidebar-border" />
        <div className="flex items-center justify-between px-7 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
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
        <div className="flex shrink-0 items-center gap-3 px-6 pb-6 pt-[max(1.5rem,env(safe-area-inset-top))]">
          <button onClick={() => setSettingsOpen(false)} className="rounded-full p-1.5 text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-5" />
          </button>
          <h3 className="font-heading text-lg tracking-wide">设置</h3>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
          <p className="px-2 text-[11px] italic text-muted-foreground leading-relaxed">
            模型 Key 只保存在当前浏览器，发送时由本站后端转发。
          </p>

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
                      {protocol === "openai" && (
                        <div>
                          <p className="mb-1.5 text-[11px] tracking-widest text-muted-foreground">快速选择</p>
                          <div className="grid grid-cols-2 gap-2">
                            {OPENAI_PRESETS.map(preset => {
                              const selected = drafts.openai?.baseUrl.trim() === preset.baseUrl
                                && drafts.openai?.model.trim() === preset.model
                              return (
                                <button
                                  key={preset.label}
                                  type="button"
                                  onClick={() => applyOpenAIPreset(preset)}
                                  className={cn(
                                    "rounded-lg border px-2 py-1.5 text-xs transition-colors",
                                    selected
                                      ? "border-sidebar-primary/40 bg-sidebar-primary/10 text-sidebar-primary"
                                      : "border-sidebar-border text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  {preset.label}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      {[
                        { field: "name" as const, label: "名称", placeholder: "例如：我的 DeepSeek", type: "text" },
                        { field: "apiKey" as const, label: "API Key", placeholder: "sk-...", type: "password" },
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
                      <details className="group rounded-lg border border-sidebar-border/70 px-2.5 py-2">
                        <summary className="cursor-pointer list-none text-[11px] tracking-wider text-muted-foreground">
                          高级配置：服务地址与模型
                        </summary>
                        <div className="mt-2.5 space-y-2.5">
                          {[
                            { field: "baseUrl" as const, label: "服务地址", placeholder: PROTOCOL_DEFAULTS[protocol].baseUrl },
                            { field: "model" as const, label: "模型名", placeholder: PROTOCOL_DEFAULTS[protocol].model },
                          ].map(({ field, label, placeholder }) => (
                            <div key={field}>
                              <p className="mb-1 text-[11px] tracking-widest text-muted-foreground">{label}</p>
                              <input
                                type="text"
                                value={drafts[protocol]?.[field] ?? ""}
                                onChange={e => updateDraftField(protocol, field, e.target.value)}
                                placeholder={placeholder}
                                className="w-full rounded-lg border border-sidebar-border bg-background/50 px-2.5 py-1.5 text-xs outline-none focus:border-sidebar-primary/50 placeholder:text-muted-foreground/40"
                              />
                            </div>
                          ))}
                        </div>
                      </details>
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

          {/* 记忆管理 */}
          <MemorySection memories={memories} onMemoriesChange={onMemoriesChange} />
        </div>
      </div>
    </aside>
  )
}

function MemorySection({ memories, onMemoriesChange }: { memories: Memory[]; onMemoriesChange: (m: Memory[]) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [newValue, setNewValue] = useState("")
  const [adding, setAdding] = useState(false)

  function deleteMemory(id: string) {
    const next = memories.filter(m => m.id !== id)
    saveMemories(next)
    onMemoriesChange(next)
  }

  function startEdit(m: Memory) {
    setEditingId(m.id)
    setEditValue(m.content)
  }

  function saveEdit() {
    if (!editingId || !editValue.trim()) return
    const next = memories.map(m => m.id === editingId ? { ...m, content: editValue.trim() } : m)
    saveMemories(next)
    onMemoriesChange(next)
    setEditingId(null)
  }

  function addMemory() {
    if (!newValue.trim()) return
    const next = [...memories, { id: `m-${Date.now()}`, content: newValue.trim() }]
    saveMemories(next)
    onMemoriesChange(next)
    setNewValue("")
    setAdding(false)
  }

  return (
    <div className="rounded-2xl border border-sidebar-border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <Brain className="size-4 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium tracking-wide">记忆</span>
        <span className="text-[11px] text-muted-foreground">{memories.length} 条</span>
      </div>
      {memories.length > 0 && (
        <div className="border-t border-sidebar-border/50 divide-y divide-sidebar-border/30">
          {memories.map(m => (
            <div key={m.id} className="px-3 py-2">
              {editingId === m.id ? (
                <div className="space-y-1.5">
                  <textarea
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit() } if (e.key === "Escape") setEditingId(null) }}
                    className="w-full rounded-lg border border-sidebar-border bg-background/50 px-2.5 py-1.5 text-xs outline-none focus:border-sidebar-primary/50 resize-none"
                    rows={2}
                  />
                  <div className="flex gap-1.5">
                    <button onClick={saveEdit} className="flex-1 rounded-lg bg-sidebar-primary px-2 py-1 text-xs text-sidebar-primary-foreground">保存</button>
                    <button onClick={() => setEditingId(null)} className="flex-1 rounded-lg border border-sidebar-border px-2 py-1 text-xs text-muted-foreground">取消</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-xs text-foreground/80 leading-relaxed">{m.content}</p>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => startEdit(m)} className="p-1 text-muted-foreground hover:text-foreground transition-colors">
                      <svg className="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button onClick={() => deleteMemory(m.id)} className="p-1 text-muted-foreground hover:text-destructive transition-colors">
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="border-t border-sidebar-border/50 px-3 py-2">
        {adding ? (
          <div className="space-y-1.5">
            <textarea
              autoFocus
              value={newValue}
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMemory() } if (e.key === "Escape") setAdding(false) }}
              placeholder="输入要记住的内容……"
              className="w-full rounded-lg border border-sidebar-border bg-background/50 px-2.5 py-1.5 text-xs outline-none focus:border-sidebar-primary/50 resize-none placeholder:text-muted-foreground/40"
              rows={2}
            />
            <div className="flex gap-1.5">
              <button onClick={addMemory} className="flex-1 rounded-lg bg-sidebar-primary px-2 py-1 text-xs text-sidebar-primary-foreground">添加</button>
              <button onClick={() => setAdding(false)} className="flex-1 rounded-lg border border-sidebar-border px-2 py-1 text-xs text-muted-foreground">取消</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="flex w-full items-center gap-1.5 rounded-xl px-1 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <Plus className="size-3.5" />手动添加记忆
          </button>
        )}
      </div>
    </div>
  )
}
