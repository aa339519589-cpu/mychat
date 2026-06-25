"use client"

import Image from "next/image"
import { useState, useEffect } from "react"
import type { Conversation } from "@/lib/chat-data"
import { ChevronDown, ChevronRight, Brain, FileText, Globe, Copy, Check, RefreshCw } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import { parseArtifact, artifactTitle } from "@/lib/artifact"
import { stripToolMarkup } from "@/lib/llm/sanitize"
import { ArtifactCard } from "@/components/artifact-card"
import { InlineArtifact } from "@/components/inline-artifact"
import { VegaChart } from "@/components/vega-chart"
import { MermaidChart } from "@/components/mermaid-chart"
import { FunctionPlotChart } from "@/components/function-plot-chart"
import { normalizeMathDelimiters } from "@/lib/math"

function MdContent({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p: ({ children }) => <p className="mb-2.5 break-words leading-[26px] tracking-[0.001em] [overflow-wrap:anywhere]">{children}</p>,
        a: ({ children, href }) => <a href={href} className="break-all underline underline-offset-4 text-primary hover:text-primary/80">{children}</a>,
        strong: ({ children }) => <strong className="font-[600]">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        del: ({ children }) => <del className="line-through text-muted-foreground/60">{children}</del>,
        code: ({ children }) => <code className="break-all rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[0.84em] font-[400]">{children}</code>,
        pre: ({ children }) => <pre className="mb-3 max-w-full overflow-x-auto rounded-lg border border-border/30 bg-muted/30 p-4 text-sm font-[400]">{children}</pre>,
        h1: ({ children }) => <h1 className="mb-3 mt-7 text-[clamp(26px,1.6em,30px)] font-[600] leading-[1.18] tracking-[-0.014em]">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2.5 mt-6 text-[clamp(23px,1.38em,26px)] font-[550] leading-[1.22] tracking-[-0.012em]">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-5 text-[clamp(20px,1.18em,23px)] font-[500] leading-[1.28] tracking-[-0.01em]">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-2 mt-4 text-[clamp(18px,1.06em,20px)] font-[500] leading-[1.34] tracking-[-0.008em]">{children}</h4>,
        h5: ({ children }) => <h5 className="mb-1.5 mt-4 text-[0.98em] font-[500] tracking-[-0.006em]">{children}</h5>,
        h6: ({ children }) => <h6 className="mb-1 mt-3 text-[0.92em] font-[400] text-muted-foreground">{children}</h6>,
        ul: ({ children }) => <ul className="mb-3 list-inside list-disc space-y-1.5 pl-2">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-inside list-decimal space-y-1.5 pl-2">{children}</ol>,
        li: ({ children }) => <li className="break-words [overflow-wrap:anywhere]">{children}</li>,
        blockquote: ({ children }) => <blockquote className="my-3 rounded-r border-l-4 border-primary/40 bg-muted/15 py-2 pl-4 pr-3 font-[400] italic text-muted-foreground">{children}</blockquote>,
        hr: () => <hr className="my-6 h-px border-0 bg-foreground/25 opacity-85" />,
        table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full overflow-hidden rounded-lg border border-collapse border-border/30">{children}</table></div>,
        thead: ({ children }) => <thead className="bg-muted/40 font-[500]">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-border/20 last:border-b-0">{children}</tr>,
        th: ({ children }) => <th className="border-r border-border/20 px-3 py-2 text-left text-sm font-[500] last:border-r-0">{children}</th>,
        td: ({ children }) => <td className="break-words border-r border-border/20 px-3 py-2 text-sm last:border-r-0 [overflow-wrap:anywhere]">{children}</td>,
        img: ({ src, alt }) => <img src={src} alt={alt} className="my-3 h-auto max-w-full rounded-lg border border-border/20" />,
      }}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  )
}

function ThinkingBlock({ thinking, active }: { thinking: string; active?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!thinking.trim()) return null
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs font-[400] italic text-muted-foreground/70 transition-colors hover:text-muted-foreground md:text-[13px]"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <span className={active ? "thinking-flow not-italic font-[500] tracking-wide" : undefined}>thinking</span>
      </button>
      {open && (
        <div className="mt-2 break-words whitespace-pre-wrap rounded-xl border border-border/30 bg-muted/15 px-4 py-2.5 text-[13px] font-[400] italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere] md:text-sm">
          {thinking}
        </div>
      )}
    </div>
  )
}

function SearchBlock({ searches, replying }: { searches: { query: string; results: { title: string; url: string }[] }[]; replying: boolean }) {
  const [open, setOpen] = useState(true)
  useEffect(() => { if (replying) setOpen(false) }, [replying])
  if (!searches.length) return null
  const total = searches.reduce((n, s) => n + s.results.length, 0)
  return (
    <div className="mb-2.5">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs font-[400] italic text-muted-foreground/70 transition-colors hover:text-muted-foreground md:text-[13px]"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Globe className="size-3.5" />
        <span>搜索了 {total} 个来源</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-xl border border-border/30 bg-muted/15 px-4 py-2.5 text-xs md:text-[13px]">
          {searches.map((s, i) => (
            <div key={i} className="space-y-1">
              <div className="text-xs font-[400] italic text-muted-foreground">搜索：{s.query}</div>
              {s.results.map((r, j) => (
                <a key={j} href={r.url} target="_blank" rel="noreferrer" className="block truncate text-xs font-[400] text-primary/80 underline underline-offset-2 hover:text-primary">
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

// 单个 AI 消息的操作栏（仅模型回复：复制 + 重新生成，常驻显示）
function AiActions({
  text, isLast, isLoading,
  onCopy, onRegenerate,
}: {
  text: string; isLast: boolean; isLoading: boolean
  onCopy?: (t: string) => void
  onRegenerate?: () => void
}) {
  const [copied, setCopied] = useState(false)
  if (!text && !isLast) return null
  function doCopy() {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
    onCopy?.(text)
  }
  return (
    <div className="mt-1.5 flex items-center gap-1">
      {text && (
        <button onClick={doCopy} title="复制" className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      )}
      {isLast && !isLoading && onRegenerate && text && (
        <button onClick={onRegenerate} title="重新生成" className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground">
          <RefreshCw className="size-4" />
        </button>
      )}
    </div>
  )
}

export function MessageList({
  conversation,
  onRegenerate,
  isLoading,
  onOpenArtifact,
  openArtifactId,
}: {
  conversation: Conversation
  onRegenerate?: () => void
  isLoading?: boolean
  onOpenArtifact?: (msgId: string) => void
  openArtifactId?: string | null
}) {
  const msgs = conversation.messages
  const lastAiIdx = [...msgs].map((m, i) => ({ m, i })).reverse().find(({ m }) => m.role === 'assistant')?.i ?? -1

  return (
    <article className="mx-auto w-full min-w-0 max-w-[58rem] overflow-x-clip px-3 py-5 sm:px-4 md:px-8 md:py-6">
      <div className="min-w-0 space-y-6 md:space-y-8">
        {msgs.map((m, idx) =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end">
              {m.images && m.images.length > 0 && (
                <div className="mb-2 flex flex-wrap justify-end gap-2">
                  {m.images.map((img, i) => (
                    <img key={i} src={img} alt="" className="max-h-48 max-w-[240px] rounded-2xl border border-border/30 object-cover" />
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
                <div className="max-w-[84%] min-w-0 rounded-[1.05rem] border border-white/10 bg-[#151515] px-4 py-2 text-left text-white shadow-sm md:max-w-[80%]">
                  <p className="break-words font-sans text-[17px] font-[400] not-italic leading-[1.38] tracking-[0.001em] text-left text-white [overflow-wrap:anywhere] md:text-[18px]">{m.content}</p>
                </div>
              )}
            </div>
          ) : (
            <div key={m.id} className="group min-w-0 pl-[6px] md:grid md:grid-cols-[3rem_minmax(0,1fr)] md:items-start md:gap-2.5 md:pl-0">
              <div className="avatar-box mb-2 h-7 w-7 flex-shrink-0 self-start md:mb-0 md:mt-0.5 md:h-11 md:w-11">
                <Image src="/companion.png" alt="" width={44} height={44} priority className="avatar-light size-7 select-none md:size-11" />
                <Image src="/companion-dark.png" alt="" width={44} height={44} priority className="avatar-dark size-7 select-none md:size-11" />
              </div>
              <div className="min-w-0 flex-1">
                {m.thinking && <ThinkingBlock thinking={m.thinking} active={!!isLoading && idx === lastAiIdx && !m.content?.trim()} />}
                {m.searchNotes && m.searchNotes.length > 0 && <SearchBlock searches={m.searchNotes} replying={!!m.content} />}
                {m.memoryNotes && m.memoryNotes.length > 0 && (
                  <div className="mb-2.5 space-y-1">
                    {m.memoryNotes.map((note, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs font-[400] italic text-muted-foreground/75 md:text-[13px]">
                        <Brain className="size-3.5 shrink-0" />
                        <span className="[overflow-wrap:anywhere]">{note}</span>
                      </div>
                    ))}
                  </div>
                )}
                {(() => {
                  // content 始终是模型原始全文，渲染时实时拆分两种 artifact
                  // stripToolMarkup 兜底：万一后端有漏网的工具协议标记（DSML 等），前端也绝不渲染出来
                  const { display, raw, done, inlineRaw, inlineDone, vegaRaw, vegaDone, mermaidRaw, mermaidDone, fnPlotRaw, fnPlotDone } = parseArtifact(stripToolMarkup(m.content ?? ''))
                  return (
                    <div className="min-w-0 space-y-2.5">
                      {m.isError ? (
                        <div>
                          <p className="break-words whitespace-pre-wrap text-sm font-[400] italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere] md:text-[15px]">{m.content}</p>
                        </div>
                      ) : (
                        <>
                          {/* 移动端正文左起约 18px；桌面端保持原 grid；正文行高 26px，字重 395 */}
                          {display && (
                            <div className="text-[17px] font-[395] text-foreground md:text-[18px]">
                              <MdContent text={display} />
                            </div>
                          )}
                          {/* Vega-Lite 图表 */}
                          {vegaRaw !== null && <VegaChart spec={vegaRaw} done={vegaDone} />}
                          {/* Mermaid 流程图 */}
                          {mermaidRaw !== null && <MermaidChart code={mermaidRaw} done={mermaidDone} />}
                          {/* Function-plot 数学函数 */}
                          {fnPlotRaw !== null && <FunctionPlotChart spec={fnPlotRaw} done={fnPlotDone} />}
                          {/* 内联 SVG */}
                          {inlineRaw !== null && <InlineArtifact svg={inlineRaw} done={inlineDone} />}
                          {/* 面板卡片（有 artifact）*/}
                          {raw !== null && (
                            <div>
                              <ArtifactCard
                                title={artifactTitle(raw)}
                                done={done}
                                active={openArtifactId === m.id}
                                onClick={() => onOpenArtifact?.(m.id)}
                              />
                            </div>
                          )}
                          {/* 操作栏与正文对齐，避免左侧再吃掉一层空白 */}
                          {(!!display || raw !== null || idx === lastAiIdx) && (
                            <div className="space-y-2.5">
                              <AiActions
                                text={display}
                                isLast={idx === lastAiIdx}
                                isLoading={!!isLoading}
                                onRegenerate={onRegenerate}
                              />
                            </div>
                          )}
                        </>
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
