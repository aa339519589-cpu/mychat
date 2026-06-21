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
        p: ({ children }) => <p className="break-words leading-[1.95] tracking-[0.01em] [overflow-wrap:anywhere]">{children}</p>,
        a: ({ children, href }) => <a href={href} className="break-all underline underline-offset-4">{children}</a>,
        code: ({ children }) => <code className="break-all rounded bg-muted/40 px-1 py-0.5 font-mono text-sm">{children}</code>,
        pre: ({ children }) => <pre className="max-w-full overflow-x-auto rounded-xl bg-muted/30 p-4 text-sm">{children}</pre>,
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
        <div className="mt-2 break-words whitespace-pre-wrap rounded-xl border border-border/40 bg-muted/20 px-4 py-3 text-[13px] italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
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
    <article className="mx-auto w-full min-w-0 max-w-[44rem] overflow-x-hidden px-4 py-6 md:px-10 md:py-16">
      <header className="mb-8 text-center md:mb-12">
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

      <div className="min-w-0 space-y-8 md:space-y-10">
        {conversation.messages.map(m =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end">
              <span className="mb-2 text-[11px] italic tracking-widest text-muted-foreground">我 · {m.time}</span>
              <div className="max-w-[85%] min-w-0 rounded-[1.5rem] rounded-tr-md bg-secondary/70 px-5 py-3.5">
                <p className="break-words text-[15px] italic leading-[1.9] tracking-wide text-secondary-foreground [overflow-wrap:anywhere]">{m.content}</p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex min-w-0 items-start gap-3 md:gap-4">
              {/* 小克 */}
              <div className="flex-shrink-0 self-start mt-1" style={{ backgroundColor: '#FCF1DE' }}>
                <Image src="/companion.png" alt="" width={56} height={56} className="size-11 select-none md:size-14" style={{ mixBlendMode: "multiply" }} />
              </div>
              <div className="min-w-0 flex-1">
                <span className="mb-2.5 block text-[11px] tracking-widest text-muted-foreground">
                  {endpointName} · {m.time}
                </span>
                {m.thinking && <ThinkingBlock thinking={m.thinking} />}
                <div className="min-w-0 border-l border-border/70 pl-4 md:pl-6">
                  {m.isError ? (
                    <p className="break-words whitespace-pre-wrap text-sm italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{m.content}</p>
                  ) : (
                    <div className="min-w-0 space-y-4 text-[15px] text-foreground/90 md:text-[17px]">
                      <MdContent text={m.content} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        )}
      </div>

      <div className="mt-12 flex items-center justify-center gap-3 text-muted-foreground md:mt-16">
        <span className="h-px w-8 bg-border" />
        <span className="text-xs tracking-[0.3em]">· 完 ·</span>
        <span className="h-px w-8 bg-border" />
      </div>
    </article>
  )
}
