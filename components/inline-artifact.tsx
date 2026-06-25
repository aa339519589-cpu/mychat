"use client"

import { useState } from "react"
import { sanitizeSvg } from "@/lib/artifact"
import { Maximize2, X } from "lucide-react"

// 内联 SVG 渲染：直接注入对话 DOM（非 iframe）
// - currentColor 继承 text-foreground，切换明暗主题时自动跟随
// - viewBox + 宽度自适应；桌面限制最大宽度，手机全宽（比例分开）
// - 背景透明，融入页面
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
      {/* 桌面端限制最大宽度，手机端全宽 */}
      <div className="group/svg relative my-3 w-full animate-in fade-in duration-300 md:max-w-2xl">
        <div
          className="w-full overflow-hidden text-foreground [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: clean }}
        />
        <button
          onClick={() => setZoom(true)}
          className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-background/40 text-muted-foreground/50 opacity-0 backdrop-blur transition-opacity hover:text-foreground group-hover/svg:opacity-100"
          aria-label="放大查看"
        >
          <Maximize2 className="size-3" />
        </button>
      </div>

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur md:p-10"
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
            className="max-h-full w-full max-w-4xl text-foreground [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:max-h-[88vh] [&>svg]:w-full"
            onClick={e => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: clean }}
          />
        </div>
      )}
    </>
  )
}
