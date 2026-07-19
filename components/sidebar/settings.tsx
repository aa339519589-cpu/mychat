"use client"

import { useState } from "react"
import { Brain, Check, Pencil, Plus, Trash2, X } from "lucide-react"

import { ModelEndpointSettings } from "@/components/model-endpoint-settings"
import type { Memory } from "@/lib/memory-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { cn } from "@/lib/utils"
import { Switch } from "./primitives"
import { QuotaScreen } from "./quota-screen"
import { SystemPromptSettings } from "./system-prompt-settings"

function MemoryScreen({ memories, enabled, onEnabledChange, onAdd, onEdit, onDelete }: {
  memories: Memory[]
  enabled: boolean
  onEnabledChange: (v: boolean) => void
  onAdd: (content: string) => void
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [newValue, setNewValue] = useState("")
  const [adding, setAdding] = useState(false)

  function startEdit(m: Memory) { setEditingId(m.id); setEditValue(m.content) }
  function saveEdit() {
    if (!editingId || !editValue.trim()) return
    onEdit(editingId, editValue.trim()); setEditingId(null)
  }
  function addMemory() {
    if (!newValue.trim()) return
    onAdd(newValue.trim()); setNewValue(""); setAdding(false)
  }

  return (
    <div className="px-4">
      <div className="flex items-start gap-3 rounded-2xl bg-sidebar-accent/55 border border-sidebar-border p-4">
        <Brain className="mt-0.5 size-5 shrink-0 text-sidebar-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">开启记忆</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            开启后，小克会在对谈中记住你透露的信息，并在需要时调用。关闭后，它既不会读取也不会写入任何记忆。
          </p>
        </div>
        <Switch checked={enabled} onChange={onEnabledChange} />
      </div>

      <div className={cn("mt-4 transition-opacity", !enabled && "opacity-40")}>
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] tracking-[0.15em] text-muted-foreground">已记住 {memories.length} 条</span>
        </div>

        <div className="rounded-2xl border border-sidebar-border bg-sidebar-accent/30 overflow-hidden">
          <div className="max-h-[340px] overflow-y-auto">
            {memories.length === 0 && !adding && (
              <p className="px-4 py-8 text-center text-[12px] italic text-muted-foreground/60">还没有记忆</p>
            )}
            {memories.length > 0 && (
              <div className="space-y-0 divide-y divide-sidebar-border/40">
                {memories.map(m => (
                  <div key={m.id} className="px-3 py-2.5">
                    {editingId === m.id ? (
                      <div className="space-y-2">
                        <textarea
                          autoFocus
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit() } if (e.key === "Escape") setEditingId(null) }}
                          className="w-full resize-none rounded-xl bg-sidebar-accent/60 border border-sidebar-accent/70 px-3 py-2 text-[12px] outline-none focus:bg-sidebar-accent/80"
                          rows={2}
                        />
                        <div className="flex gap-2">
                          <button onClick={saveEdit} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[12px] text-sidebar-primary-foreground"><Check className="size-3.5" />保存</button>
                          <button onClick={() => setEditingId(null)} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/60 py-1.5 text-[12px] text-muted-foreground"><X className="size-3.5" />取消</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <p className="flex-1 text-[12px] leading-relaxed text-foreground/85">{m.content}</p>
                        <div className="flex shrink-0 gap-0.5">
                          <button onClick={() => startEdit(m)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="编辑"><Pencil className="size-3.5" /></button>
                          <button onClick={() => onDelete(m.id)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除"><Trash2 className="size-3.5" /></button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {adding && (
              <div className="px-3 py-2.5 space-y-2 border-t border-sidebar-border/40">
                <textarea
                  autoFocus
                  value={newValue}
                  onChange={e => setNewValue(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMemory() } if (e.key === "Escape") setAdding(false) }}
                  placeholder="输入要记住的内容……"
                  className="w-full resize-none rounded-xl bg-sidebar-accent/60 border border-sidebar-accent/70 px-3 py-2 text-[12px] outline-none placeholder:text-muted-foreground/40 focus:bg-sidebar-accent/80"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button onClick={addMemory} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[12px] text-sidebar-primary-foreground"><Check className="size-3.5" />添加</button>
                  <button onClick={() => setAdding(false)} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-accent/60 py-1.5 text-[12px] text-muted-foreground"><X className="size-3.5" />取消</button>
                </div>
              </div>
            )}
          </div>
          {!adding && (
            <button onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 border-t border-sidebar-border/40 py-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-foreground">
              <Plus className="size-4" />添加记忆
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function SettingsScreen({
  memories, memoryEnabled, onMemoryEnabledChange, onMemoryAdd, onMemoryEdit, onMemoryDelete,
  modelEndpoints, activeEndpointId, onEndpointSelect, onEndpointCreated, onEndpointUpdated, onEndpointDeleted,
}: {
  memories: Memory[]
  memoryEnabled: boolean
  onMemoryEnabledChange: (v: boolean) => void
  onMemoryAdd: (content: string) => void
  onMemoryEdit: (id: string, content: string) => void
  onMemoryDelete: (id: string) => void
  modelEndpoints: ModelEndpointSummary[]
  activeEndpointId: string | null
  onEndpointSelect: (id: string) => void
  onEndpointCreated: (endpoint: ModelEndpointSummary) => void
  onEndpointUpdated: (endpoint: ModelEndpointSummary) => void
  onEndpointDeleted: (id: string) => void
}) {
  const [tab, setTab] = useState<'general' | 'models' | 'prompt' | 'quota'>('general')

  const pill = (active: boolean) =>
    cn("rounded-full px-3.5 py-1.5 text-[12px] transition-colors", active ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-sidebar-border shadow-sm" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")

  return (
    <div>
      <div className="mb-1 flex gap-1.5 overflow-x-auto px-4 pb-1">
        <button onClick={() => setTab('general')} className={pill(tab === 'general')}>记忆</button>
        <button onClick={() => setTab('models')} className={pill(tab === 'models')}>模型</button>
        <button onClick={() => setTab('prompt')} className={pill(tab === 'prompt')}>系统提示词</button>
        <button onClick={() => setTab('quota')} className={pill(tab === 'quota')}>使用额度</button>
      </div>

      {tab === 'general' ? (
        <div className="pt-2">
          <MemoryScreen
            memories={memories}
            enabled={memoryEnabled}
            onEnabledChange={onMemoryEnabledChange}
            onAdd={onMemoryAdd}
            onEdit={onMemoryEdit}
            onDelete={onMemoryDelete}
          />
        </div>
      ) : tab === 'models' ? (
        <div className="pt-2">
          <ModelEndpointSettings
            endpoints={modelEndpoints}
            activeEndpointId={activeEndpointId}
            onSelect={onEndpointSelect}
            onCreated={onEndpointCreated}
            onUpdated={onEndpointUpdated}
            onDeleted={onEndpointDeleted}
          />
        </div>
      ) : tab === 'prompt' ? (
        <div className="pt-2">
          <SystemPromptSettings />
        </div>
      ) : (
        <div className="pt-2">
          <QuotaScreen />
        </div>
      )}
    </div>
  )
}
