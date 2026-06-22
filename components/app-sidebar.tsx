"use client"

import { useState } from "react"
import type { Conversation } from "@/lib/chat-data"
import type { Memory } from "@/lib/memory-data"
import { cn } from "@/lib/utils"
import {
  Feather, Plus, ChevronLeft, ChevronRight, Trash2, Brain, LogOut,
  Settings, Folder, Shapes, Pencil, Check, X,
} from "lucide-react"

// 二级页面：除根视图（侧栏主体）外的所有可滑入页面
type Screen = "settings" | "memory" | "account" | "projects" | "artifacts"

// 层级 z-index：从根进入的为一级(10)，从设置再进入的为二级(20)。
// 同级页面从不同时出现，因此静态 z 即可，退场时仍盖在被揭开的页面之上，滑出动画才完整。
const Z: Record<Screen, number> = {
  settings: 10, projects: 10, artifacts: 10,
  memory: 20, account: 20,
}

export type AppSidebarProps = {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  memories: Memory[]
  onMemoryAdd: (content: string) => void
  onMemoryEdit: (id: string, content: string) => void
  onMemoryDelete: (id: string) => void
  memoryEnabled: boolean
  onMemoryEnabledChange: (v: boolean) => void
  userEmail: string
  onLogout: () => void
}

export function AppSidebar(props: AppSidebarProps) {
  const { conversations, activeId, onDelete, userEmail, onLogout } = props
  const [stack, setStack] = useState<Screen[]>([])
  const [userMenuOpen, setUserMenuOpen] = useState(false)

  const push = (s: Screen) => { setUserMenuOpen(false); setStack(prev => [...prev, s]) }
  const pop = () => setStack(prev => prev.slice(0, -1))

  // 选对话 / 新建时，收起所有二级页面与菜单，回到干净的根视图
  const handleSelect = (id: string) => { setStack([]); setUserMenuOpen(false); props.onSelect(id) }
  const handleNew = () => { setStack([]); setUserMenuOpen(false); props.onNew() }

  function screenStyle(s: Screen): React.CSSProperties {
    const inStack = stack.includes(s)
    return {
      transform: inStack ? "translateX(0)" : "translateX(100%)",
      zIndex: Z[s],
      pointerEvents: inStack ? "auto" : "none",
    }
  }

  const initial = (userEmail.slice(0, 1) || "我").toUpperCase()

  return (
    <aside className="relative flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">

      {/* ───────── 根视图 ───────── */}
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 px-5 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
          <Feather className="size-4 text-sidebar-primary" />
          <span className="font-heading text-base tracking-wide">简</span>
        </div>

        <button
          onClick={handleNew}
          className="mx-4 mb-2 flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm tracking-wide text-sidebar-foreground transition-colors hover:bg-sidebar-accent"
        >
          <Plus className="size-4 text-sidebar-primary" />
          起一篇新的对谈
        </button>

        {/* 主导航：项目 / 作品 */}
        <nav className="mx-4 space-y-0.5">
          <NavRow icon={<Folder className="size-4" />} label="项目" onClick={() => push("projects")} />
          <NavRow icon={<Shapes className="size-4" />} label="作品" onClick={() => push("artifacts")} />
        </nav>

        <div className="mx-7 my-3 border-t border-sidebar-border/60" />
        <p className="px-7 pb-2 text-[11px] tracking-[0.2em] text-muted-foreground/70">近期</p>

        {/* 对话列表 */}
        <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-3">
          {conversations.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] italic text-muted-foreground/60">还没有对谈</p>
          ) : conversations.map(c => {
            const isActive = c.id === activeId
            return (
              <div key={c.id} className="group relative">
                <button
                  onClick={() => handleSelect(c.id)}
                  className={cn("block w-full rounded-2xl px-4 py-3 pr-9 text-left transition-colors", isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60")}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className={cn("truncate font-heading text-[15px] leading-snug tracking-wide", isActive ? "text-sidebar-primary" : "text-sidebar-foreground")}>{c.title}</span>
                    <span className="shrink-0 text-[11px] tracking-wider text-muted-foreground">{c.date}</span>
                  </div>
                  {c.excerpt && <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{c.excerpt}</p>}
                </button>
                <button
                  onClick={e => { e.stopPropagation(); onDelete(c.id) }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground/40 transition-colors hover:bg-sidebar-accent hover:text-destructive"
                  aria-label="删除对话"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )
          })}
        </div>

        {/* 用户页脚：点开 → 设置 / 退出 */}
        <div className="relative border-t border-sidebar-border px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          {userMenuOpen && (
            <>
              <button className="fixed inset-0 z-10 cursor-default" aria-label="关闭菜单" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute bottom-[calc(100%-0.25rem)] left-3 right-3 z-20 overflow-hidden rounded-2xl border border-sidebar-border bg-card shadow-lg">
                <button onClick={() => push("settings")} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-foreground transition-colors hover:bg-sidebar-accent/60">
                  <Settings className="size-4 text-muted-foreground" />设置
                </button>
                <div className="border-t border-sidebar-border/50" />
                <button onClick={onLogout} className="flex w-full items-center gap-3 px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-destructive">
                  <LogOut className="size-4" />退出登录
                </button>
              </div>
            </>
          )}
          <button
            onClick={() => setUserMenuOpen(v => !v)}
            className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition-colors hover:bg-sidebar-accent/60"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/15 text-sm text-sidebar-primary">{initial}</div>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{userEmail || "已登录"}</span>
            <ChevronRight className={cn("size-4 shrink-0 text-muted-foreground transition-transform", userMenuOpen && "-rotate-90")} />
          </button>
        </div>
      </div>

      {/* ───────── 二级页面（覆盖在根视图之上，滑入/滑出） ───────── */}

      {/* 设置菜单 */}
      <ScreenPanel style={screenStyle("settings")} title="设置" onBack={pop}>
        <div className="space-y-1 px-3">
          <MenuRow icon={<Brain className="size-4" />} label="记忆" hint={`${props.memories.length} 条`} onClick={() => push("memory")} />
          <MenuRow icon={<div className="flex size-4 items-center justify-center rounded-full bg-sidebar-primary/15 text-[10px] text-sidebar-primary">{initial}</div>} label="账户" onClick={() => push("account")} />
        </div>
      </ScreenPanel>

      {/* 记忆页 */}
      <ScreenPanel style={screenStyle("memory")} title="记忆" onBack={pop}>
        <MemoryScreen
          memories={props.memories}
          enabled={props.memoryEnabled}
          onEnabledChange={props.onMemoryEnabledChange}
          onAdd={props.onMemoryAdd}
          onEdit={props.onMemoryEdit}
          onDelete={props.onMemoryDelete}
        />
      </ScreenPanel>

      {/* 账户页 */}
      <ScreenPanel style={screenStyle("account")} title="账户" onBack={pop}>
        <div className="px-5">
          <div className="flex items-center gap-3 rounded-2xl border border-sidebar-border p-4">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-sidebar-primary/15 text-lg text-sidebar-primary">{initial}</div>
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{userEmail || "已登录"}</p>
              <p className="text-[12px] text-muted-foreground">已登录</p>
            </div>
          </div>
          <button
            onClick={onLogout}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-sidebar-border py-3 text-sm text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          >
            <LogOut className="size-4" />退出登录
          </button>
        </div>
      </ScreenPanel>

      {/* 项目（占位，下一批填充） */}
      <ScreenPanel style={screenStyle("projects")} title="项目" onBack={pop}>
        <ComingSoon
          icon={<Folder className="size-7" />}
          title="项目即将上线"
          desc="把相关的对谈归到一个项目里，为它设定专属人设与参考资料，项目内的每段对谈都会自动沿用。"
        />
      </ScreenPanel>

      {/* 作品（占位，下一批填充） */}
      <ScreenPanel style={screenStyle("artifacts")} title="作品" onBack={pop}>
        <ComingSoon
          icon={<Shapes className="size-7" />}
          title="作品库即将上线"
          desc="你与小克共同创作过的可交互页面会收藏在这里，随时回看、下载。"
        />
      </ScreenPanel>
    </aside>
  )
}

// ── 二级页面外壳：统一的返回头 + 滑动动画 ──
function ScreenPanel({ style, title, onBack, children }: {
  style: React.CSSProperties
  title: string
  onBack: () => void
  children: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 flex flex-col bg-sidebar transition-transform duration-300 ease-out" style={style}>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button onClick={onBack} className="-ml-1 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="返回">
          <ChevronLeft className="size-5" />
        </button>
        <h3 className="font-heading text-lg tracking-wide">{title}</h3>
      </div>
      <div className="flex-1 overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
    </div>
  )
}

function NavRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-2xl px-3 py-2.5 text-sm tracking-wide text-sidebar-foreground transition-colors hover:bg-sidebar-accent">
      <span className="text-muted-foreground">{icon}</span>{label}
    </button>
  )
}

function MenuRow({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left transition-colors hover:bg-sidebar-accent/60">
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1 text-sm text-foreground">{label}</span>
      {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      <ChevronRight className="size-4 text-muted-foreground/50" />
    </button>
  )
}

function ComingSoon({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="mx-auto flex h-full max-w-xs flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-sidebar-accent/60 text-sidebar-primary">{icon}</div>
      <p className="font-heading text-base tracking-wide text-foreground">{title}</p>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{desc}</p>
    </div>
  )
}

// ── 开关 ──
function Switch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-sidebar-primary" : "bg-muted-foreground/30")}
    >
      <span className={cn("absolute left-0.5 top-0.5 size-5 rounded-full bg-card shadow transition-transform", checked && "translate-x-5")} />
    </button>
  )
}

// ── 记忆页主体：总开关 + 列表（编辑/删除）+ 手动添加 ──
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
      {/* 总开关 */}
      <div className="flex items-start gap-3 rounded-2xl border border-sidebar-border p-4">
        <Brain className="mt-0.5 size-5 shrink-0 text-sidebar-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">开启记忆</p>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            开启后，小克会在对谈中记住你透露的信息，并在需要时调用。关闭后，它既不会读取也不会写入任何记忆。
          </p>
        </div>
        <Switch checked={enabled} onChange={onEnabledChange} />
      </div>

      {/* 列表 */}
      <div className={cn("mt-4 transition-opacity", !enabled && "opacity-40")}>
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[12px] tracking-[0.15em] text-muted-foreground">已记住 {memories.length} 条</span>
        </div>

        <div className="space-y-2">
          {memories.length === 0 && !adding && (
            <p className="rounded-2xl border border-dashed border-sidebar-border px-4 py-6 text-center text-[13px] italic text-muted-foreground/70">还没有记忆</p>
          )}

          {memories.map(m => (
            <div key={m.id} className="rounded-2xl border border-sidebar-border px-3 py-2.5">
              {editingId === m.id ? (
                <div className="space-y-2">
                  <textarea
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit() } if (e.key === "Escape") setEditingId(null) }}
                    className="w-full resize-none rounded-xl border border-sidebar-border bg-background/50 px-3 py-2 text-[13px] outline-none focus:border-sidebar-primary/50"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[13px] text-sidebar-primary-foreground"><Check className="size-3.5" />保存</button>
                    <button onClick={() => setEditingId(null)} className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-sidebar-border py-1.5 text-[13px] text-muted-foreground"><X className="size-3.5" />取消</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <p className="flex-1 text-[13px] leading-relaxed text-foreground/85">{m.content}</p>
                  <div className="flex shrink-0 gap-0.5">
                    <button onClick={() => startEdit(m)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="编辑"><Pencil className="size-3.5" /></button>
                    <button onClick={() => onDelete(m.id)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除"><Trash2 className="size-3.5" /></button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {adding ? (
            <div className="space-y-2 rounded-2xl border border-sidebar-border px-3 py-2.5">
              <textarea
                autoFocus
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMemory() } if (e.key === "Escape") setAdding(false) }}
                placeholder="输入要记住的内容……"
                className="w-full resize-none rounded-xl border border-sidebar-border bg-background/50 px-3 py-2 text-[13px] outline-none placeholder:text-muted-foreground/40 focus:border-sidebar-primary/50"
                rows={2}
              />
              <div className="flex gap-2">
                <button onClick={addMemory} className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-sidebar-primary py-1.5 text-[13px] text-sidebar-primary-foreground"><Check className="size-3.5" />添加</button>
                <button onClick={() => setAdding(false)} className="flex flex-1 items-center justify-center gap-1 rounded-xl border border-sidebar-border py-1.5 text-[13px] text-muted-foreground"><X className="size-3.5" />取消</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setAdding(true)} className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-sidebar-border py-2.5 text-[13px] text-muted-foreground transition-colors hover:border-sidebar-primary/40 hover:text-foreground">
              <Plus className="size-4" />手动添加记忆
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
