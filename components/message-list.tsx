"use client"

import Image from "next/image"
import { useState } from "react"
import type { Conversation } from "@/lib/chat-data"
import { ChevronDown, ChevronRight } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"

function MdContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p: ({ children }) => <p className="leading-[1.95] tracking-[0.01em] text-pretty">{children}</p>,
        code: ({ children }) => <code className="rounded bg-muted/40 px-1 py-0.5 text-sm font-mono">{children}</code>,
        pre: ({ children }) => <pre className="rounded-xl bg-muted/30 p-4 text-sm overflow-x-auto">{children}</pre>,
        ul: ({ children }) => <ul className="list-disc pl-5 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 space-y-1">{children}</ol>,
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function ThinkingBlock({ thinking }: { thinking: string }) {
  const [open, setOpen] = useState(false)
  if (!thinking.trim()) return null
  return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs italic text-muted-foreground/70 hover:text-muted-foreground transition-colors"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span>思考过程</span>
      </button>
      {open && (
        <div className="mt-2 rounded-xl border border-border/40 bg-muted/20 px-4 py-3 text-[13px] italic leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {thinking}
        </div>
      )}
    </div>
  )
}

export function MessageList({
  conversation,
  endpointName,
}: {
  conversation: Conversation
  endpointName: string
}) {
  return (
    <article className="mx-auto max-w-[44rem] px-6 py-12 md:px-10 md:py-16">
      <header className="mb-12 text-center">
        <p className="text-xs uppercase tracking-[0.35em] text-muted-foreground">
          {conversation.date} · 与 {endpointName} 对谈
        </p>
        <h2 className="mt-4 font-heading text-3xl font-medium tracking-wide text-foreground md:text-4xl text-balance">
          {conversation.title}
        </h2>
        <div className="mx-auto mt-6 flex items-center justify-center gap-3 text-primary">
          <span className="h-px w-10 bg-border" />
          <span className="text-sm">❧</span>
          <span className="h-px w-10 bg-border" />
        </div>
      </header>

      <div className="space-y-10">
        {conversation.messages.map(m =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end">
              <span className="mb-2 text-[11px] italic tracking-widest text-muted-foreground">我 · {m.time}</span>
              <div className="max-w-[85%] rounded-[1.5rem] rounded-tr-md bg-secondary/70 px-5 py-3.5">
                <p className="text-[15px] italic leading-[1.9] tracking-wide text-secondary-foreground text-pretty">{m.content}</p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex gap-4 items-start">
              {/* 小克 */}
              <div className="flex-shrink-0 self-start mt-1" style={{ backgroundColor: '#FCF1DE' }}>
                <Image src="/companion.png" alt="" width={56} height={56} className="w-14 h-14 select-none" style={{ mixBlendMode: "multiply" }} />
              </div>
              <div className="flex-1 min-w-0">
                <span className="mb-2.5 block text-[11px] tracking-widest text-muted-foreground">
                  {endpointName} · {m.time}
                </span>
                {m.thinking && <ThinkingBlock thinking={m.thinking} />}
                <div className="border-l border-border/70 pl-5 md:pl-6">
                  {m.isError ? (
                    <p className="text-sm italic text-muted-foreground">{m.content}</p>
                  ) : (
                    <div className="space-y-4 text-[17px] text-foreground/90">
                      <MdContent text={m.content} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        )}
      </div>

      <div className="mt-16 flex items-center justify-center gap-3 text-muted-foreground">
        <span className="h-px w-8 bg-border" />
        <span className="text-xs tracking-[0.3em]">· 完 ·</span>
        <span className="h-px w-8 bg-border" />
      </div>
    </article>
  )
}
