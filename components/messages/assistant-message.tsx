"use client"

import { useEffect, useState } from "react"
import { Brain, Check, ChevronDown, ChevronRight, Copy, Globe, RefreshCw } from "lucide-react"

import { ArtifactCard } from "@/components/artifact-card"
import { FunctionPlotChart } from "@/components/function-plot-chart"
import { GeneratedMedia } from "@/components/generated-media"
import { InlineArtifact } from "@/components/inline-artifact"
import { MermaidChart } from "@/components/mermaid-chart"
import { VegaChart } from "@/components/vega-chart"
import { artifactTitle, parseArtifact, type ArtifactBlock } from "@/lib/artifact"
import type { Message } from "@/lib/chat-data"
import { stripToolMarkup } from "@/lib/llm/sanitize"
import { normalizeSearchNotes } from "@/lib/search-notes"
import { MessageMarkdown } from "./markdown-content"

type Searches = NonNullable<Message["searchNotes"]>

function SearchBlock({ searches, replying }: { searches: Searches; replying: boolean }) {
  const [open, setOpen] = useState(true)
  useEffect(() => { if (replying) setOpen(false) }, [replying])
  const safeSearches = normalizeSearchNotes(searches)
  const total = safeSearches.reduce((count, search) => count + search.results.length, 0)
  if (total === 0) return null
  return (
    <div className="mb-2.5">
      <button
        onClick={() => setOpen(value => !value)}
        className="flex items-center gap-1.5 text-xs font-[500] italic text-muted-foreground/70 transition-colors hover:text-muted-foreground md:text-[12px]"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        <Globe className="size-3.5" />
        <span>搜索了 {total} 个来源</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-xl border border-border/30 bg-muted/15 px-4 py-2.5 text-xs md:text-[12px]">
          {safeSearches.map((search, searchIndex) => (
            <div key={searchIndex} className="space-y-1">
              <div className="text-xs font-[500] italic text-muted-foreground">搜索：{search.query}</div>
              {search.results.map((result, resultIndex) => (
                <a key={resultIndex} href={result.url} target="_blank" rel="noopener noreferrer" className="block truncate text-xs font-[500] text-primary/80 underline underline-offset-2 hover:text-primary">
                  {result.title || result.url}
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AssistantActions({
  text,
  isLast,
  isLoading,
  hasOutput,
  onRegenerate,
}: {
  text: string
  isLast: boolean
  isLoading: boolean
  hasOutput?: boolean
  onRegenerate?: () => void
}) {
  const [copied, setCopied] = useState(false)
  if (!text && !hasOutput) return null

  function copy() {
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="mt-1.5 flex items-center gap-1">
      {text && (
        <button onClick={copy} title="复制" className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-foreground">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
      )}
      {isLast && !isLoading && onRegenerate && (text || hasOutput) && (
        <button onClick={onRegenerate} title="重新生成" className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-primary/10 hover:text-foreground">
          <RefreshCw className="size-4" />
        </button>
      )}
    </div>
  )
}

function ArtifactOutput({
  block,
  active,
  onOpen,
}: {
  block: ArtifactBlock
  active: boolean
  onOpen: () => void
}) {
  switch (block.kind) {
    case "vega":
      return <VegaChart spec={block.raw} done={block.done} />
    case "mermaid":
      return <MermaidChart code={block.raw} done={block.done} />
    case "function-plot":
      return <FunctionPlotChart spec={block.raw} done={block.done} />
    case "inline-artifact":
      return <InlineArtifact svg={block.raw} done={block.done} />
    case "artifact":
      return (
        <div>
          <ArtifactCard
            title={artifactTitle(block.raw)}
            done={block.done}
            active={active}
            onClick={onOpen}
          />
        </div>
      )
  }
}

function ArtifactOutputs({
  blocks,
  active,
  onOpen,
}: {
  blocks: ArtifactBlock[]
  active: boolean
  onOpen: () => void
}) {
  return blocks.map((block, index) => (
    <ArtifactOutput
      key={`${block.kind}:${index}`}
      block={block}
      active={active}
      onOpen={onOpen}
    />
  ))
}

export function AssistantMessage({
  message,
  isLast,
  isLoading,
  openArtifactId,
  onOpenArtifact,
  onRegenerate,
}: {
  message: Message
  isLast: boolean
  isLoading: boolean
  openArtifactId?: string | null
  onOpenArtifact?: (messageId: string) => void
  onRegenerate?: () => void
}) {
  const { display, blocks } = parseArtifact(stripToolMarkup(message.content ?? ""))
  const hasArtifactOutput = blocks.length > 0

  return (
    <div className="group min-w-0 pl-[6px] md:pl-0">
      <div className="min-w-0">
        {message.searchNotes && message.searchNotes.length > 0 && (
          <SearchBlock searches={message.searchNotes} replying={!!message.content} />
        )}
        {message.memoryNotes && message.memoryNotes.length > 0 && (
          <div className="mb-2.5 space-y-1">
            {message.memoryNotes.map((note, index) => (
              <div key={index} className="flex items-center gap-1.5 text-xs font-[500] italic text-muted-foreground/75 md:text-[12px]">
                <Brain className="size-3.5 shrink-0" />
                <span className="[overflow-wrap:anywhere]">{note}</span>
              </div>
            ))}
          </div>
        )}
        {isLast && isLoading && !message.content && !message.media?.length && !message.isError && (
          <div role="status" aria-live="polite">
            <span className="thinking-flow" data-text="Thinking">Thinking</span>
          </div>
        )}
        <div className="min-w-0 space-y-2.5">
          {message.isError ? (
            <div>
              <p className="break-words whitespace-pre-wrap text-sm font-[500] italic leading-relaxed text-muted-foreground [overflow-wrap:anywhere] md:text-[14px]">{message.content}</p>
            </div>
          ) : (
            <>
              {display && (
                <div className="text-[16px] font-[500] text-foreground md:text-[17px]">
                  <MessageMarkdown text={display} />
                </div>
              )}
              {message.media && message.media.length > 0 && (
                <div className="min-w-0 space-y-3">
                  {message.media.map((media, mediaIndex) => (
                    <GeneratedMedia
                      key={`${message.id}:${media.type}:${media.url.slice(0, 80)}:${mediaIndex}`}
                      media={media}
                      messageId={message.id}
                    />
                  ))}
                </div>
              )}
              <ArtifactOutputs
                blocks={blocks}
                active={openArtifactId === message.id}
                onOpen={() => onOpenArtifact?.(message.id)}
              />
              {(!!display || !!message.media?.length || hasArtifactOutput || isLast) && (
                <div className="space-y-2.5">
                  <AssistantActions
                    text={display}
                    hasOutput={!!message.media?.length || hasArtifactOutput}
                    isLast={isLast}
                    isLoading={isLoading}
                    onRegenerate={onRegenerate}
                  />
                </div>
              )}
            </>
          )}
          {message.outputWarning && (
            <p role="alert" className="break-words rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm leading-relaxed text-destructive [overflow-wrap:anywhere]">
              {message.outputWarning}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
