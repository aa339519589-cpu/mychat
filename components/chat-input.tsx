"use client"

import { useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { ArrowUp, Plus } from "lucide-react"

export function ChatInput({
  onSend,
}: {
  onSend: (text: string) => void
  modelName?: string
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

  return (
    <div className="mx-auto w-full max-w-[44rem] px-6 pb-8 pt-2 md:px-10">
      <div className="flex items-end gap-3 rounded-full border border-border/70 bg-card/70 py-2 pl-4 pr-2">
        <button
          type="button"
          className="mb-0.5 shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="添加附件"
        >
          <Plus className="size-5" aria-hidden />
        </button>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            resize()
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="说点什么……"
          aria-label="说点什么"
          className="block max-h-[180px] flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-[1.7] tracking-wide text-foreground outline-none placeholder:italic placeholder:text-muted-foreground"
        />
        <button
          onClick={submit}
          disabled={!value.trim()}
          aria-label="发送"
          className={cn(
            "mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors",
            value.trim()
              ? "bg-primary text-primary-foreground hover:opacity-90"
              : "cursor-not-allowed bg-secondary text-muted-foreground",
          )}
        >
          <ArrowUp className="size-5" aria-hidden />
        </button>
      </div>
    </div>
  )
}
