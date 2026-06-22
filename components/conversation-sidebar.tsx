"use client"

import { useState } from "react"
import type { Conversation } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import { cn } from "@/lib/utils"
import { Feather, Plus, Settings, ChevronLeft, Trash2, Brain, LogOut } from "lucide-react"

export function ConversationSidebar({
  conversations, activeId, onSelect, onNew, onDelete,
  memories, onMemoryAdd, onMemoryEdit, onMemoryDelete, userEmail, onLogout,
}: {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  memories: Memory[]
  onMemoryAdd: (content: string) => void
  onMemoryEdit: (id: string, content: string) => void
  onMemoryDelete: (id: string) => void
  userEmail: string
  onLogout: () => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <aside className="relative flex h-full w-full flex-col bg-sidebar text-sidebar-foreground overflow-hidden">

      {/* ── 主视图 ── */}
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <Feather className="size-4 text-sidebar-primary" />
          <span className="font-heading text-base tracking-wide text-sidebar-foreground">简</span>
        </div>

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
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground/40 hover:bg-sidebar-accent hover:text-destructive transition-colors"
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

      {/* ── 设置面板 ── */}
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
          {/* 记忆管理 */}
          <MemorySection memories={memories} onAdd={onMemoryAdd} onEdit={onMemoryEdit} onDelete={onMemoryDelete} />

          {/* 账号 */}
          <div className="rounded-2xl border border-sidebar-border overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/15 text-xs text-sidebar-primary">
                {userEmail.slice(0, 1).toUpperCase() || "我"}
              </div>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{userEmail || "已登录"}</span>
            </div>
            <button
              onClick={onLogout}
              className="flex w-full items-center gap-2 border-t border-sidebar-border/50 px-4 py-2.5 text-xs text-muted-foreground hover:bg-sidebar-accent/40 hover:text-destructive transition-colors"
            >
              <LogOut className="size-3.5" />退出登录
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function MemorySection({ memories, onAdd, onEdit, onDelete }: {
  memories: Memory[]
  onAdd: (content: string) => void
  onEdit: (id: string, content: string) => void
  onDelete: (id: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const [newValue, setNewValue] = useState("")
  const [adding, setAdding] = useState(false)

  function startEdit(m: Memory) {
    setEditingId(m.id)
    setEditValue(m.content)
  }

  function saveEdit() {
    if (!editingId || !editValue.trim()) return
    onEdit(editingId, editValue.trim())
    setEditingId(null)
  }

  function addMemory() {
    if (!newValue.trim()) return
    onAdd(newValue.trim())
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
        <div className="max-h-64 overflow-y-auto border-t border-sidebar-border/50 divide-y divide-sidebar-border/30">
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
                    <button onClick={() => onDelete(m.id)} className="p-1 text-muted-foreground hover:text-destructive transition-colors">
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
