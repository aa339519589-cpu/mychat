"use client"

import { useEffect, useRef, useState } from "react"
import vegaEmbed from "vega-embed"
import { Maximize2, X } from "lucide-react"

export function VegaChart({ spec, done }: { spec: string; done: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const zoomContainerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(false)
  const [error, setError] = useState(false)

  const renderChart = (container: HTMLDivElement | null) => {
    if (!container || !spec.trim()) return

    try {
      const parsed = JSON.parse(spec)
      const vegaSpec = {
        ...parsed,
        $schema: parsed.$schema || "https://vega.github.io/schema/vega-lite/v5.json",
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
        },
      }

      vegaEmbed(container, vegaSpec, {
        actions: false,
        downloadFileName: "chart",
      }).catch((err) => {
        console.error("Vega-Embed error:", err)
        setError(true)
      })
    } catch (err) {
      console.error("JSON parse error:", err)
      setError(true)
    }
  }

  useEffect(() => {
    renderChart(containerRef.current)
  }, [spec])

  useEffect(() => {
    if (zoom) {
      renderChart(zoomContainerRef.current)
    }
  }, [zoom])

  if (error) {
    return done ? null : (
      <div className="my-3 text-xs text-red-500/50">图表解析失败</div>
    )
  }

  if (!spec.trim()) {
    return done ? null : (
      <div className="my-3 text-xs italic text-muted-foreground/50">图表生成中……</div>
    )
  }

  return (
    <>
      <div className="group/chart relative my-3 w-full">
        <div
          ref={containerRef}
          className="w-full text-foreground [&>div]:block [&>div]:h-auto [&>div]:w-full [&>svg]:w-full [&>svg]:h-auto"
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
            className="max-h-full w-full max-w-4xl text-foreground [&>div]:mx-auto [&>div]:block [&>div]:h-auto [&>div]:max-h-[88vh] [&>div]:w-full [&>svg]:max-h-[88vh] [&>svg]:w-full"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </>
  )
}
