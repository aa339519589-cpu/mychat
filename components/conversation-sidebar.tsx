"use client"

import type { Conversation, ModelId, Model } from "@/lib/chat-data"
import { cn } from "@/lib/utils"
import { Feather, Plus, Settings, X, ChevronLeft } from "lucide-react"
import { useState } from "react"

const PROVIDERS = [
  { id: "claude" as ModelId, label: "Claude", hint: "Anthropic API Key", placeholder: "sk-ant-..." },
  { id: "gpt" as ModelId, label: "GPT", hint: "OpenAI API Key", placeholder: "sk-..." },
  { id: "gemini" as ModelId, label: "Gemini", hint: "Google AI API Key", placeholder: "AIza..." },
  { id: "deepseek" as ModelId, label: "DeepSeek", hint: "DeepSeek API Key", placeholder: "sk-..." },
]

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  apiKeys,
  selectedModel,
  onSaveKey,
  onModelChange,
}: {
  conversations: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  apiKeys: Record<string, string>
  selectedModel: ModelId
  onSaveKey: (model: string, key: string) => void
  onModelChange: (model: ModelId) => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <aside className="relative flex h-full w-full flex-col bg-sidebar text-sidebar-foreground overflow-hidden">

      {/* 主内容 */}
      <div className="flex h-full flex-col">
        {/* 刊头 */}
        <div className="px-7 pb-6 pt-8">
          <div className="flex items-center gap-2.5">
            <Feather className="size-5 text-sidebar-primary" aria-hidden />
            <h1 className="font-heading text-2xl tracking-wide text-sidebar-foreground">笺</h1>
          </div>
          <p className="mt-2 text-xs leading-relaxed tracking-wider text-muted-foreground">
            文字对谈集 · 卷一
          </p>
        </div>

        <div className="mx-7 mb-5 border-t border-sidebar-border" aria-hidden />

        {/* 当前模型选择 */}
        <div className="mx-5 mb-4">
          <p className="mb-2 px-3 text-[11px] tracking-widest text-muted-foreground">当前笔友</p>
          <div className="grid grid-cols-2 gap-1.5">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                onClick={() => onModelChange(p.id)}
                className={cn(
                  "rounded-xl px-3 py-2 text-left text-xs tracking-wide transition-colors",
                  selectedModel === p.id
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onNew}
          className="mx-5 mb-4 flex items-center gap-2 rounded-full px-3 py-2 text-sm tracking-wide text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Plus className="size-4" aria-hidden />
          起一篇新的对谈
        </button>

        {/* 目录 */}
        <nav aria-label="对话历史" className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
          {conversations.map((c) => {
            const isActive = c.id === activeId
            return (
              <button
                key={c.id}
                onClick={() => onSelect(c.id)}
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "group block w-full rounded-2xl px-4 py-3 text-left transition-colors",
                  isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
                )}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className={cn("font-heading text-[15px] leading-snug tracking-wide", isActive ? "text-sidebar-primary" : "text-sidebar-foreground")}>
                    {c.title}
                  </span>
                  <span className="shrink-0 text-[11px] tracking-wider text-muted-foreground">{c.date}</span>
                </div>
                <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{c.excerpt}</p>
              </button>
            )
          })}
        </nav>

        {/* 底部 */}
        <div className="mx-7 border-t border-sidebar-border" aria-hidden />
        <div className="flex items-center justify-between px-7 py-4">
          <p className="text-[11px] italic leading-relaxed tracking-wider text-muted-foreground">
            「文字是缓慢的，正因如此，<br />才值得珍藏。」
          </p>
          <button
            onClick={() => setSettingsOpen(true)}
            className="ml-3 shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            aria-label="API 设置"
          >
            <Settings className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* 设置面板（滑入覆盖侧边栏） */}
      <div className={cn(
        "absolute inset-0 z-10 flex flex-col bg-sidebar transition-transform duration-300",
        settingsOpen ? "translate-x-0" : "translate-x-full",
      )}>
        <div className="flex items-center gap-3 px-6 py-6">
          <button
            onClick={() => setSettingsOpen(false)}
            className="rounded-full p-1.5 text-muted-foreground hover:text-foreground"
            aria-label="返回"
          >
            <ChevronLeft className="size-5" />
          </button>
          <h3 className="font-heading text-lg tracking-wide">API 设置</h3>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-8 space-y-6">
          <p className="text-[12px] italic text-muted-foreground leading-relaxed">
            Key 仅存于你的浏览器本地，不会上传任何服务器。填写哪个，就可以使用哪个模型。
          </p>

          {PROVIDERS.map((p) => (
            <div key={p.id}>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs tracking-widest text-muted-foreground">{p.hint}</label>
                {apiKeys[p.id] && (
                  <span className="text-[11px] text-green-600 dark:text-green-400">✓ 已配置</span>
                )}
              </div>
              <input
                type="password"
                value={apiKeys[p.id] ?? ""}
                onChange={(e) => onSaveKey(p.id, e.target.value)}
                placeholder={p.placeholder}
                className="w-full rounded-xl border border-sidebar-border bg-background/50 px-3.5 py-2.5 text-sm outline-none focus:border-sidebar-primary/50 placeholder:text-muted-foreground/50"
              />
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
