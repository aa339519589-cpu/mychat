"use client"

import { useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { Send } from "lucide-react"

export function ChatInput({
  onSend,
  modelName,
}: {
  onSend: (text: string) => void
  modelName: string
}) {
  const [value, setValue] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)

  function resize() {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = Math.min(el.scrollHeight, 200) + "px"
  }

  function submit() {
    const text = value.trim()
    if (!text) return
    onSend(text)
    setValue("")
    if (ref.current) ref.current.style.height = "auto"
  }

  return (
    <div className="mx-auto w-full max-w-[44rem] px-6 pb-8 pt-4 md:px-10">
      <div className="rounded-sm border border-border bg-card/80 px-5 py-4 shadow-[0_1px_0_oklch(0.4_0.04_50_/_0.06)]">
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
          placeholder={`提笔写下，与 ${modelName} 对谈……`}
          aria-label="书写你的话语"
          className="block w-full resize-none bg-transparent text-[16px] leading-[1.9] tracking-wide text-foreground outline-none placeholder:italic placeholder:text-muted-foreground"
        />
        <div className="mt-3 flex items-center justify-between border-t border-border/70 pt-3">
          <span className="text-[11px] italic tracking-wider text-muted-foreground">
            Enter 落笔 · Shift + Enter 换行
          </span>
          <button
            onClick={submit}
            disabled={!value.trim()}
            className={cn(
              "flex items-center gap-2 rounded-sm px-4 py-1.5 text-sm tracking-wide transition-colors",
              value.trim()
                ? "bg-primary text-primary-foreground hover:opacity-90"
                : "cursor-not-allowed bg-secondary text-muted-foreground",
            )}
          >
            落笔
            <Send className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  )
}
