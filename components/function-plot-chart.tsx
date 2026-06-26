"use client"

import { useEffect, useRef, useState } from "react"

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return "函数图配置无效或渲染器执行失败"
}

function plotSize(element: HTMLDivElement) {
  const mobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
  const containerWidth = Math.max(260, element.clientWidth || (mobile ? 340 : 500))
  const width = Math.min(containerWidth, mobile ? 360 : 640)
  const height = mobile
    ? Math.min(260, Math.max(210, Math.round(width * 0.68)))
    : 320
  return { width, height }
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
        if (cancelled) return
        const { width, height } = plotSize(element)
        element.innerHTML = ""
        functionPlot({
          target: element,
          width,
          height,
          grid: true,
          ...config,
        })
        const svg = element.querySelector("svg")
        if (svg) {
          svg.style.maxWidth = "100%"
          svg.style.height = "auto"
        }
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

  return <div ref={ref} className="my-3 flex w-full min-w-0 justify-center overflow-hidden animate-in fade-in duration-300 [&>svg]:max-h-[42dvh] [&>svg]:max-w-full md:[&>svg]:max-h-[62dvh]" />
}
