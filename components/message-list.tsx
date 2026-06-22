"use client"

import Image from "next/image"
import { useState, useEffect } from "react"
import type { Conversation } from "@/lib/chat-data"
import { ChevronDown, ChevronRight, Brain, FileText, Globe } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import { parseArtifact } from "@/lib/artifact"
import { ArtifactFrame } from "@/components/artifact-frame"

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

// 联网搜索来源：搜索时默认展开，模型开始回复后自动收起（仿 Claude）
function SearchBlock({ searches, replying }: { searches: { query: string; results: { title: string; url: string }[] }[]; replying: boolean }) {
  const [open, setOpen] = useState(true)
  useEffect(() => { if (replying) setOpen(false) }, [replying])
  if (!searches.length) return null
  const total = searches.reduce((n, s) => n + s.results.length, 0)
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs italic text-muted-foreground/70 hover:text-muted-foreground transition-colors"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Globe className="size-3" />
        <span>搜索了 {total} 个来源</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2.5 rounded-xl border border-border/40 bg-muted/20 px-4 py-3">
          {searches.map((s, i) => (
            <div key={i} className="space-y-1">
              <div className="text-xs italic text-muted-foreground">搜索：{s.query}</div>
              {s.results.map((r, j) => (
                <a key={j} href={r.url} target="_blank" rel="noreferrer" className="block truncate text-xs text-primary/80 underline underline-offset-2 hover:text-primary">
                  {r.title || r.url}
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function MessageList({
  conversation,
}: {
  conversation: Conversation
}) {
  return (
    <article className="mx-auto w-full min-w-0 max-w-[44rem] overflow-x-hidden px-4 py-6 md:px-6 md:py-8">
      <div className="min-w-0 space-y-8 md:space-y-10">
        {conversation.messages.map(m =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end">
              {m.images && m.images.length > 0 && (
                <div className="mb-2 flex flex-wrap justify-end gap-2">
                  {m.images.map((img, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={img} alt="" className="max-h-48 max-w-[240px] rounded-2xl object-cover border border-border/30" />
                  ))}
                </div>
              )}
              {m.files && m.files.length > 0 && (
                <div className="mb-2 flex flex-wrap justify-end gap-2">
                  {m.files.map((name, i) => (
                    <div key={i} className="flex items-center gap-1.5 rounded-2xl border border-border/40 bg-secondary/60 px-3.5 py-2.5">
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                      <span className="max-w-[180px] truncate text-sm text-secondary-foreground">{name}</span>
                    </div>
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
                <Image src="/companion.png" alt="" width={40} height={40} priority className="avatar-light size-8 select-none md:size-10" />
                <Image src="/companion-dark.png" alt="" width={40} height={40} priority className="avatar-dark size-8 select-none md:size-10" />
              </div>
              <div className="min-w-0 flex-1">
                {m.thinking && <ThinkingBlock thinking={m.thinking} />}
                {m.searchNotes && m.searchNotes.length > 0 && <SearchBlock searches={m.searchNotes} replying={!!m.content} />}
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
                {(() => {
                  // 如果 artifactHtml 已经由流式解析器注入（streaming state），直接用；
                  // 否则从 content 里解析（从数据库加载时 content 包含原始 <artifact> 标签）
                  const hasPreParsed = m.artifactHtml !== undefined
                  const { display, artifactHtml, artifactLoading } = hasPreParsed
                    ? { display: m.content, artifactHtml: m.artifactHtml ?? null, artifactLoading: m.artifactLoading ?? false }
                    : parseArtifact(m.content ?? '')
                  return (
                    <div className="min-w-0 border-l border-border/70 pl-3">
                      {m.isError ? (
                        <p className="break-words whitespace-pre-wrap text-sm italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{m.content}</p>
                      ) : (
                        <div className="min-w-0 space-y-4 text-[15px] text-foreground/90 md:text-[17px]">
                          {display && <MdContent text={display} />}
                          <ArtifactFrame html={artifactHtml} loading={artifactLoading} />
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            </div>
          )
        )}
      </div>
    </article>
  )
}
