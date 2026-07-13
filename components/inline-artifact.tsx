"use client"

import { useEffect, useMemo, useState } from "react"
import Image from "next/image"
import { sanitizeSvg } from "@/lib/artifact"
import { Maximize2, X } from "lucide-react"

function numericAttr(tag: string, name: string): number | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']?([0-9.]+)`, "i"))
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

function svgAspect(svg: string): number | null {
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0]
  if (!tag) return null

  const viewBox = tag.match(/\sviewBox\s*=\s*["']\s*[-0-9.]+[,\s]+[-0-9.]+[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i)
  if (viewBox) {
    const w = Number(viewBox[1])
    const h = Number(viewBox[2])
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return w / h
  }

  const w = numericAttr(tag, "width")
  const h = numericAttr(tag, "height")
  return w && h ? w / h : null
}

function fitWidthForViewport(aspect: number | null): string {
  if (typeof window === "undefined" || !aspect) return "100%"
  const desktop = window.matchMedia("(min-width: 768px)").matches
  const viewportCap = window.innerHeight * (desktop ? 0.62 : 0.42)
  const hardCap = desktop ? 620 : 360
  const maxHeight = Math.min(viewportCap, hardCap)
  const width = Math.max(220, Math.round(maxHeight * aspect))
  return `min(100%, ${width}px)`
}

// 内联 SVG 渲染：已清洗内容通过 Data URL 与对话 DOM 隔离
// - 桌面/手机分开限制：手机按视口高度收缩，桌面保留更大预览
// - 背景透明，融入页面
export function InlineArtifact({ svg, done }: { svg: string; done: boolean }) {
  const [zoom, setZoom] = useState(false)
  const clean = sanitizeSvg(svg)
  const aspect = useMemo(() => clean ? svgAspect(clean) : null, [clean])
  const [fitWidth, setFitWidth] = useState(() => fitWidthForViewport(aspect))
  const src = useMemo(
    () => clean ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}` : "",
    [clean],
  )

  useEffect(() => {
    const update = () => setFitWidth(fitWidthForViewport(aspect))
    update()
    window.addEventListener("resize", update)
    window.addEventListener("orientationchange", update)
    return () => {
      window.removeEventListener("resize", update)
      window.removeEventListener("orientationchange", update)
    }
  }, [aspect])

  if (!clean) {
    // 流式中还没输出 <svg> 时给个占位；已完成却非 SVG 则静默（文字部分通常已有内容）
    return done ? null : (
      <div className="my-3 text-xs italic text-muted-foreground/50">图形生成中……</div>
    )
  }

  return (
    <>
      {/* 桌面端限制最大宽度，手机端按屏幕高度动态收缩 */}
      <div className="group/svg relative my-3 flex w-full min-w-0 justify-center overflow-hidden animate-in fade-in duration-300 md:max-w-2xl">
        <Image
          src={src}
          alt="生成的图形"
          width={1024}
          height={aspect ? Math.max(1, Math.round(1024 / aspect)) : 1024}
          unoptimized
          style={{ width: fitWidth }}
          className="block h-auto min-w-0 max-h-[42dvh] max-w-full object-contain md:max-h-[62dvh]"
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
            className="max-h-full w-full max-w-4xl"
            onClick={e => e.stopPropagation()}
          >
            <Image
              src={src}
              alt="生成的图形（放大）"
              width={1024}
              height={aspect ? Math.max(1, Math.round(1024 / aspect)) : 1024}
              unoptimized
              className="mx-auto block h-auto max-h-[88dvh] max-w-full object-contain"
            />
          </div>
        </div>
      )}
    </>
  )
}
