"use client"

import { useEffect, useRef, useState } from "react"
import vegaEmbed from "vega-embed"
import { Maximize2, X } from "lucide-react"

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return "图表配置无效或渲染器执行失败"
}

function isDesktopViewport() {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches
}

function responsiveHeight(value: unknown) {
  const desktop = isDesktopViewport()
  const fallback = desktop ? 320 : 240
  const cap = desktop ? 420 : 260
  return typeof value === "number" ? Math.min(value, cap) : value ?? fallback
}

function chartMaxHeight(): string {
  return isDesktopViewport() ? "62dvh" : "42dvh"
}

function normalizeSpec(spec: string) {
  const parsed = JSON.parse(spec)
  return {
    ...parsed,
    $schema: parsed.$schema || "https://vega.github.io/schema/vega-lite/v5.json",
    width: "container",
    height: responsiveHeight(parsed.height),
    autosize: parsed.autosize ?? { type: "fit", contains: "padding", resize: true },
    background: "transparent",
    config: {
      ...parsed.config,
      background: "transparent",
      text: { color: "currentColor", ...parsed.config?.text },
      axis: {
        labelColor: "currentColor",
        titleColor: "currentColor",
        domainColor: "rgba(128, 128, 128, 0.3)",
        gridColor: "rgba(128, 128, 128, 0.2)",
        ...parsed.config?.axis,
      },
      legend: {
        labelColor: "currentColor",
        titleColor: "currentColor",
        ...parsed.config?.legend,
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
    svg.removeAttribute("width")
    svg.removeAttribute("height")
    svg.style.width = "100%"
    svg.style.height = "auto"
    svg.style.maxWidth = "100%"
    svg.style.maxHeight = chartMaxHeight()
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
      <div className="group/chart relative my-3 flex w-full min-w-0 justify-center overflow-hidden animate-in fade-in duration-300">
        <div
          ref={containerRef}
          className="w-full min-w-0 text-foreground [&>div]:block [&>div]:h-auto [&>div]:w-full [&>svg]:h-auto [&>svg]:max-h-[42dvh] [&>svg]:max-w-full [&>svg]:w-full md:[&>svg]:max-h-[62dvh]"
        />
        <button
          onClick={() => setZoom(true)}
          className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-background/40 text-muted-foreground/50 opacity-0 backdrop-blur transition-opacity hover:text-foreground group-hover/chart:opacity-100"
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
            ref={zoomContainerRef}
            className="max-h-full w-full max-w-4xl text-foreground [&>div]:mx-auto [&>div]:block [&>div]:h-auto [&>div]:max-h-[88dvh] [&>div]:w-full [&>svg]:h-auto [&>svg]:max-h-[88dvh] [&>svg]:max-w-full [&>svg]:w-full"
            onClick={event => event.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}
