"use client"

import { useEffect, useRef, useState } from "react"
import vegaEmbed from "vega-embed"
import { Maximize2, X } from "lucide-react"
import { VisualReveal } from "@/components/visual-reveal"

const VISUAL_INK = "#2B221C"
const VISUAL_BORDER = "#CDB798"
const VISUAL_GRID = "rgba(115, 92, 68, 0.18)"
const VEGA_PALETTE = ["#EB6A2A", "#2F8CA3", "#B34C63", "#618A3D", "#D3A128", "#6D5B98"]

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return "图表配置无效或渲染器执行失败"
}

function normalizeSpec(spec: string) {
  const parsed = JSON.parse(spec)
  return {
    ...parsed,
    $schema: parsed.$schema || "https://vega.github.io/schema/vega-lite/v5.json",
    width: parsed.width ?? "container",
    autosize: parsed.autosize ?? { type: "fit-x", contains: "padding", resize: true },
    background: "transparent",
    config: {
      ...parsed.config,
      background: "transparent",
      range: {
        category: VEGA_PALETTE,
        ...parsed.config?.range,
      },
      text: { color: VISUAL_INK, ...parsed.config?.text },
      axis: {
        labelColor: VISUAL_INK,
        titleColor: VISUAL_INK,
        domainColor: VISUAL_BORDER,
        gridColor: VISUAL_GRID,
        ...parsed.config?.axis,
      },
      legend: {
        labelColor: VISUAL_INK,
        titleColor: VISUAL_INK,
        ...parsed.config?.legend,
      },
      header: {
        labelColor: VISUAL_INK,
        titleColor: VISUAL_INK,
        ...parsed.config?.header,
      },
      view: {
        stroke: "transparent",
        ...parsed.config?.view,
      },
    },
  }
}

async function renderChartInto(container: HTMLDivElement, spec: string) {
  container.innerHTML = ""
  const result = await vegaEmbed(container, normalizeSpec(spec), {
    actions: false,
    renderer: "svg",
    downloadFileName: "chart",
  })
  const svg = container.querySelector("svg")
  if (svg) {
    svg.removeAttribute("height")
    svg.style.width = "100%"
    svg.style.height = "auto"
    svg.style.maxWidth = "100%"
  }
  return () => result.view.finalize()
}

export function VegaChart({ spec, done }: { spec: string; done: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const zoomContainerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
  }, [spec, done])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const element = container
    if (!done || !spec.trim()) {
      element.innerHTML = ""
      return
    }

    let cancelled = false
    let cleanup: (() => void) | null = null

    ;(async () => {
      try {
        cleanup = await renderChartInto(element, spec)
        if (cancelled) cleanup()
      } catch (err) {
        if (!cancelled) {
          element.innerHTML = ""
          setError(describeError(err))
        }
      }
    })()

    return () => {
      cancelled = true
      cleanup?.()
      element.innerHTML = ""
    }
  }, [spec, done])

  useEffect(() => {
    const container = zoomContainerRef.current
    if (!zoom || !container || !done || !spec.trim() || error) return

    let cancelled = false
    let cleanup: (() => void) | null = null

    ;(async () => {
      try {
        cleanup = await renderChartInto(container, spec)
        if (cancelled) cleanup()
      } catch {
        if (!cancelled) container.innerHTML = ""
      }
    })()

    return () => {
      cancelled = true
      cleanup?.()
      container.innerHTML = ""
    }
  }, [zoom, spec, done, error])

  if (!done) {
    return <div className="my-3 text-xs italic text-muted-foreground/50">图表生成中……</div>
  }

  if (!spec.trim()) {
    return <div className="my-3 text-xs text-muted-foreground/60">图表内容为空</div>
  }

  if (error) {
    return (
      <div className="my-3 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-500/80">
        图表显示失败：{error}
      </div>
    )
  }

  return (
    <>
      <VisualReveal ready={done && !error && !!spec.trim()} signature={spec} className="my-3 w-full">
        <div className="group/chart relative w-full">
          <div className="visual-surface rounded-[1.55rem] p-4 md:p-5">
            <div
              ref={containerRef}
              className="w-full overflow-hidden [&>div]:block [&>div]:h-auto [&>div]:w-full [&>svg]:h-auto [&>svg]:w-full"
            />
          </div>
          <button
            onClick={() => setZoom(true)}
            className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-full bg-white/85 text-[color:var(--visual-ink)] opacity-0 shadow-sm backdrop-blur transition-opacity hover:opacity-100 group-hover/chart:opacity-100"
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
          <div className="visual-surface max-h-full w-full max-w-4xl rounded-[1.9rem] p-4 md:p-6" onClick={event => event.stopPropagation()}>
            <div
              ref={zoomContainerRef}
              className="[&>div]:mx-auto [&>div]:block [&>div]:h-auto [&>div]:max-h-[88vh] [&>div]:w-full [&>svg]:max-h-[88vh] [&>svg]:w-full"
            />
          </div>
        </div>
      )}
    </>
  )
}
