"use client"

import { useState } from "react"
import { sanitizeSvg } from "@/lib/artifact"
import { Maximize2, X } from "lucide-react"
import { VisualReveal } from "@/components/visual-reveal"

// 内联 SVG 渲染：直接注入对话 DOM（非 iframe）
// - 统一放进固定浅色画布，不受明暗主题污染
// - 若 SVG 仍在用 currentColor，也会继承固定墨色
// - viewBox + 宽度自适应；桌面限制最大宽度，手机全宽
export function InlineArtifact({ svg, done }: { svg: string; done: boolean }) {
  const [zoom, setZoom] = useState(false)
  const clean = sanitizeSvg(svg)

  if (!clean) {
    // 流式中还没输出 <svg> 时给个占位；已完成却非 SVG 则静默（文字部分通常已有内容）
    return done ? null : (
      <div className="my-3 text-xs italic text-muted-foreground/50">图形生成中……</div>
    )
  }

  return (
    <>
      <VisualReveal ready={!!clean} signature={done ? "done" : "stream"} className="my-3 w-full md:max-w-2xl">
        <div className="group/svg relative w-full">
          <div
            className="visual-surface w-full overflow-hidden rounded-[1.55rem] p-4 text-[color:var(--visual-ink)] md:p-5 [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
            dangerouslySetInnerHTML={{ __html: clean }}
          />
          <button
            onClick={() => setZoom(true)}
            className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full bg-white/85 text-[color:var(--visual-ink)] opacity-0 shadow-sm backdrop-blur transition-opacity hover:opacity-100 group-hover/svg:opacity-100"
            aria-label="放大查看"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>
      </VisualReveal>

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/92 p-4 backdrop-blur md:p-10"
          onClick={() => setZoom(false)}
        >
          <button
            onClick={() => setZoom(false)}
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-card text-foreground shadow"
            aria-label="关闭"
          >
            <X className="size-5" />
          </button>
          <div
            className="visual-surface max-h-full w-full max-w-4xl rounded-[1.9rem] p-4 text-[color:var(--visual-ink)] md:p-6 [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:max-h-[88vh] [&>svg]:w-full"
            onClick={e => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: clean }}
          />
        </div>
      )}
    </>
  )
}
