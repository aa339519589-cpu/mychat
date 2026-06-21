"use client"

import type { Conversation, Model } from "@/lib/chat-data"

function Paragraphs({
  text,
  dropCap,
}: {
  text: string
  dropCap?: boolean
}) {
  const paras = text.split("\n").filter((p) => p.trim().length > 0)
  return (
    <>
      {paras.map((p, i) => (
        <p
          key={i}
          className={
            "leading-[1.95] tracking-[0.01em] text-pretty " +
            (dropCap && i === 0 ? "drop-cap" : "")
          }
        >
          {p}
        </p>
      ))}
    </>
  )
}

export function MessageList({
  conversation,
  model,
}: {
  conversation: Conversation
  model: Model
}) {
  return (
    <article className="mx-auto max-w-[44rem] px-6 py-12 md:px-10 md:py-16">
      {/* 篇首 */}
      <header className="mb-12 text-center">
        <p className="text-xs uppercase tracking-[0.35em] text-muted-foreground">
          {conversation.date} · 与 {model.name} 对谈
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
        {conversation.messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end">
              <span className="mb-2 text-[11px] italic tracking-widest text-muted-foreground">
                我 · {m.time}
              </span>
              <div className="max-w-[85%] rounded-sm border-r-2 border-primary/50 bg-secondary/70 px-5 py-3.5">
                <p className="text-[15px] italic leading-[1.9] tracking-wide text-secondary-foreground text-pretty">
                  {m.content}
                </p>
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex flex-col items-start">
              <span className="mb-2.5 text-[11px] tracking-widest text-muted-foreground">
                {model.name} · {m.time}
              </span>
              <div className="space-y-4 text-[17px] text-foreground/90">
                <Paragraphs text={m.content} dropCap />
              </div>
            </div>
          ),
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
