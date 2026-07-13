"use client"

import ReactMarkdown from "react-markdown"
import Image from "next/image"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"

import {
  isPrivateNetworkGeneratedMediaUrl,
  isSafeGeneratedMediaUrl,
} from "@/lib/generated-media"
import { normalizeMathDelimiters } from "@/lib/math"
import { prepareChatMarkdown } from "@/lib/markdown"

export function MessageMarkdown({ text }: { text: string }) {
  const markdown = prepareChatMarkdown(normalizeMathDelimiters(text))
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        p: ({ children }) => <p className="mb-2.5 break-words leading-[26px] tracking-[0.001em] [overflow-wrap:anywhere]">{children}</p>,
        a: ({ children, href }) => <a href={href} className="break-all text-primary underline underline-offset-4 hover:text-primary/80">{children}</a>,
        strong: ({ children }) => <strong className="font-[750]">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        del: ({ children }) => <del className="text-muted-foreground/60 line-through">{children}</del>,
        code: ({ children }) => <code className="break-all rounded bg-muted/40 px-1.5 py-0.5 font-mono text-[0.84em] font-[500]">{children}</code>,
        pre: ({ children }) => <pre className="mb-3 max-w-full overflow-x-auto rounded-lg border border-border/30 bg-muted/30 p-4 text-sm font-[500]">{children}</pre>,
        h1: ({ children }) => <h1 className="mb-3 mt-7 text-[clamp(26px,1.6em,30px)] font-[750] leading-[1.18] tracking-[-0.014em]">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2.5 mt-6 text-[clamp(23px,1.38em,26px)] font-[688] leading-[1.22] tracking-[-0.012em]">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-5 text-[clamp(20px,1.18em,23px)] font-[625] leading-[1.28] tracking-[-0.01em]">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-2 mt-4 text-[clamp(18px,1.06em,20px)] font-[625] leading-[1.34] tracking-[-0.008em]">{children}</h4>,
        h5: ({ children }) => <h5 className="mb-1.5 mt-4 text-[0.98em] font-[625] tracking-[-0.006em]">{children}</h5>,
        h6: ({ children }) => <h6 className="mb-1 mt-3 text-[0.92em] font-[500] text-muted-foreground">{children}</h6>,
        ul: ({ children }) => <ul className="mb-3 list-inside list-disc space-y-1.5 pl-2">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-inside list-decimal space-y-1.5 pl-2">{children}</ol>,
        li: ({ children }) => <li className="break-words [overflow-wrap:anywhere]">{children}</li>,
        blockquote: ({ children }) => <blockquote className="my-3 rounded-r border-l-4 border-primary/40 bg-muted/15 py-2 pl-4 pr-3 font-[500] italic text-muted-foreground">{children}</blockquote>,
        hr: () => <hr className="my-6 h-px border-0 bg-foreground/25 opacity-85" />,
        table: ({ children }) => <div className="markdown-body my-3 max-w-full overflow-x-auto"><table className="w-full min-w-[28rem] border-collapse rounded-lg border border-border/30">{children}</table></div>,
        thead: ({ children }) => <thead className="bg-muted/40 font-[625]">{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-border/20 last:border-b-0">{children}</tr>,
        th: ({ children }) => <th className="border-r border-border/20 px-3 py-2 text-left text-sm font-[625] last:border-r-0">{children}</th>,
        td: ({ children }) => <td className="break-words border-r border-border/20 px-3 py-2 text-sm last:border-r-0 [overflow-wrap:anywhere]">{children}</td>,
        img: ({ src, alt }) => isSafeGeneratedMediaUrl("image", src) ? (
          <Image
            src={src}
            alt={alt ?? ""}
            width={1024}
            height={768}
            unoptimized
            className="my-3 h-auto max-w-full rounded-lg border border-border/20"
          />
        ) : (
          <span role="alert" className="my-3 block rounded-lg border border-destructive/30 px-3 py-2 text-sm text-muted-foreground">
            {isPrivateNetworkGeneratedMediaUrl(src)
              ? "已阻止正文图片直接访问本机或内网地址。"
              : "正文图片链接不安全或不受支持。"}
          </span>
        ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  )
}
