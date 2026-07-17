"use client"

import { useEffect, useMemo, useState, type CSSProperties } from "react"
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

function LiveSvg({
  svg,
  label,
  className,
  style,
}: {
  svg: string
  label: string
  className: string
  style?: CSSProperties
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

// 内联 SVG 渲染：清洗后直接写入 DOM，让流式输出每增加一段就立即重绘。
// sanitizeSvg 会为未完成的流临时补齐 </svg>，因此不需要等待整张图生成完。
export function InlineArtifact({ svg, done }: { svg: string; done: boolean }) {
  const [zoom, setZoom] = useState(false)
  const clean = sanitizeSvg(svg)
  const aspect = useMemo(() => clean ? svgAspect(clean) : null, [clean])
  const [fitWidth, setFitWidth] = useState(() => fitWidthForViewport(aspect))

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
    return done ? null : (
      <div className="my-3 text-xs italic text-muted-foreground/50">图形生成中……</div>
    )
  }

  return (
    <>
      <div className="group/svg relative my-3 flex w-full min-w-0 justify-center overflow-hidden animate-in fade-in duration-300 md:max-w-2xl">
        <LiveSvg
          svg={clean}
          label="生成的图形"
          style={{ width: fitWidth }}
          className="min-w-0 max-w-full [&>svg]:block [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-w-full"
        />
        <button
          type="button"
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
            type="button"
            onClick={() => setZoom(false)}
            className="absolute right-4 top-4 flex size-9 items-center justify-center rounded-full bg-card text-foreground shadow"
            aria-label="关闭"
          >
            <X className="size-5" />
          </button>
          <div
            className="max-h-full w-full max-w-4xl"
            onClick={event => event.stopPropagation()}
          >
            <LiveSvg
              svg={clean}
              label="生成的图形（放大）"
              className="w-full [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:max-h-[88dvh] [&>svg]:w-full [&>svg]:max-w-full"
            />
          </div>
        </div>
      )}
    </>
  )
}
