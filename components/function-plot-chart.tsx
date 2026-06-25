"use client"

import { useEffect, useRef, useState } from "react"

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
        if (cancelled) return
        element.innerHTML = ""
        functionPlot({
          target: element,
          width: Math.min(element.clientWidth || 500, 640),
          height: 320,
          grid: true,
          ...config,
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

  return <div ref={ref} className="my-3 w-full overflow-x-auto animate-in fade-in duration-300 [&>svg]:max-w-full" />
}
