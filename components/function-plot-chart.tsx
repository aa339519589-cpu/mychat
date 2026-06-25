"use client"

import { useEffect, useRef, useState } from "react"
import { VisualReveal } from "@/components/visual-reveal"

const PLOT_PALETTE = ["#EB6A2A", "#2F8CA3", "#B34C63", "#618A3D", "#D3A128", "#6D5B98"]

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return "函数图配置无效或渲染器执行失败"
}

export function FunctionPlotChart({ spec, done }: { spec: string; done: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setError(null)
  }, [spec, done])

  useEffect(() => {
    const container = ref.current
    if (!container) return
    const element = container
    if (!done || !spec.trim()) {
      element.innerHTML = ""
      return
    }

    let cancelled = false

    async function render() {
      try {
        const functionPlot = (await import("function-plot")).default
        const config = JSON.parse(spec)
        const data = Array.isArray(config.data)
          ? config.data.map((entry: Record<string, unknown>, index: number) =>
            entry && typeof entry === "object"
              ? { ...entry, color: typeof entry.color === "string" ? entry.color : PLOT_PALETTE[index % PLOT_PALETTE.length] }
              : entry)
          : config.data
        if (cancelled) return
        element.innerHTML = ""
        functionPlot({
          target: element,
          width: Math.min(element.clientWidth || 500, 640),
          height: 320,
          grid: true,
          ...config,
          data,
        })
        const svg = element.querySelector("svg")
        if (svg) {
          svg.removeAttribute("height")
          svg.style.width = "100%"
          svg.style.height = "auto"
          svg.style.maxWidth = "100%"
        }
        element.querySelectorAll("text").forEach(node => {
          node.setAttribute("fill", "#2B221C")
        })
        element.querySelectorAll(".x.axis path, .x.axis line, .y.axis path, .y.axis line, .grid path, .grid line").forEach(node => {
          node.setAttribute("stroke", "rgba(115, 92, 68, 0.22)")
        })
        setError(null)
      } catch (err) {
        if (!cancelled) {
          element.innerHTML = ""
          setError(describeError(err))
        }
      }
    }

    render()
    return () => {
      cancelled = true
      element.innerHTML = ""
    }
  }, [spec, done])

  if (!done) return <div className="my-3 text-xs italic text-muted-foreground/50">函数图像生成中……</div>
  if (error) {
    return (
      <div className="my-3 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-500/80">
        函数图像显示失败：{error}
      </div>
    )
  }

  return (
    <VisualReveal ready={done && !error && !!spec.trim()} signature={spec} className="my-3 w-full">
      <div className="visual-surface rounded-[1.55rem] p-4 md:p-5">
        <div ref={ref} className="w-full overflow-x-auto [&>svg]:max-w-full" />
      </div>
    </VisualReveal>
  )
}
