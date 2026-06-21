"use client"

import { useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { ChevronDown } from "lucide-react"
import type { Endpoint } from "@/lib/chat-data"

export function ChatInput({
  onSend, endpoints, activeEndpointId, onEndpointChange, memoryEnabled,
}: {
  onSend: (text: string) => void
  endpoints: Endpoint[]
  activeEndpointId: string
  onEndpointChange: (id: string) => void
  memoryEnabled: boolean
}) {
  const [value, setValue] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)

  function resize() {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 180) + "px"
  }

  function submit() {
    const text = value.trim()
    if (!text) return
    onSend(text)
    setValue("")
    if (ref.current) ref.current.style.height = "auto"
  }

  const activeEndpoint = endpoints.find(e => e.id === activeEndpointId)

  return (
    <div className="mx-auto w-full max-w-[44rem] px-6 pb-8 pt-2 md:px-10">
      {/* 模型选择器 */}
      {memoryEnabled ? (
        <div className="mb-2 flex items-center gap-2 px-1">
          <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs italic text-primary">
            记忆系统已接管对话
          </span>
        </div>
      ) : endpoints.length > 0 && (
        <div className="mb-2 flex items-center gap-2 px-1">
          <div className="relative">
            <select
              value={activeEndpointId}
              onChange={e => onEndpointChange(e.target.value)}
              className="appearance-none rounded-full border border-border/50 bg-secondary/50 pl-3 pr-7 py-1 text-xs text-muted-foreground outline-none cursor-pointer hover:border-border transition-colors"
            >
              {endpoints.map(ep => (
                <option key={ep.id} value={ep.id}>{ep.name}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3 text-muted-foreground" />
          </div>
        </div>
      )}

      {/* 输入框 */}
      <div className="flex items-end gap-3 rounded-full border border-border/70 bg-card/70 py-2 pl-4 pr-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={e => { setValue(e.target.value); resize() }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit() } }}
          placeholder="说点什么……"
          className="block max-h-[180px] flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-[1.7] tracking-wide text-foreground outline-none placeholder:italic placeholder:text-muted-foreground"
        />
        <button
          onClick={submit}
          disabled={!value.trim()}
          className={cn(
            "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border transition-colors font-heading text-base",
            value.trim()
              ? "border-primary/50 bg-primary/10 text-primary hover:bg-primary/20"
              : "cursor-not-allowed border-border/40 text-muted-foreground/30",
          )}
        >
          发
        </button>
      </div>
    </div>
  )
}
