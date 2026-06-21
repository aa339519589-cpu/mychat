"use client"

import Image from "next/image"
import { useState } from "react"
import type { Conversation } from "@/lib/chat-data"
import { ChevronDown, ChevronRight, Brain } from "lucide-react"
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
    <article className="mx-auto w-full min-w-0 max-w-[44rem] overflow-x-hidden px-4 py-6 md:px-6 md:py-8">
      <div className="min-w-0 space-y-8 md:space-y-10">
        {conversation.messages.map(m =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end">
              <span className="mb-2 text-[11px] italic tracking-widest text-muted-foreground">我 · {m.time}</span>
              {m.images && m.images.length > 0 && (
                <div className="mb-2 flex flex-wrap justify-end gap-2">
                  {m.images.map((img, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={img} alt="" className="max-h-48 max-w-[240px] rounded-2xl object-cover border border-border/30" />
                  ))}
                </div>
              )}
              {m.content && (
                <div className="max-w-[85%] min-w-0 rounded-[1.5rem] rounded-tr-md bg-secondary/70 px-5 py-3.5">
                  <p className="break-words text-[15px] italic leading-[1.9] tracking-wide text-secondary-foreground [overflow-wrap:anywhere]">{m.content}</p>
                </div>
              )}
            </div>
          ) : (
            <div key={m.id} className="flex min-w-0 items-start gap-2">
              <div className="avatar-box flex-shrink-0 self-start mt-0.5">
                <Image src="/companion.png" alt="" width={40} height={40} priority className="avatar-light size-8 select-none md:size-10" style={{ mixBlendMode: "multiply" }} />
                <Image src="/companion-dark.png" alt="" width={40} height={40} priority className="avatar-dark size-8 select-none md:size-10" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="mb-2 block text-[11px] tracking-widest text-muted-foreground">
                  {endpointName} · {m.time}
                </span>
                {m.thinking && <ThinkingBlock thinking={m.thinking} />}
                {m.memoryNotes && m.memoryNotes.length > 0 && (
                  <div className="mb-3 space-y-1">
                    {m.memoryNotes.map((note, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs italic text-muted-foreground/80">
                        <Brain className="size-3 shrink-0" />
                        <span className="[overflow-wrap:anywhere]">{note}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="min-w-0 border-l border-border/70 pl-3">
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
    </article>
  )
}
