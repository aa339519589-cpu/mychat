"use client"

import { useEffect, useRef, useState } from "react"

export function FunctionPlotChart({ spec, done }: { spec: string; done: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!done || !spec.trim() || !ref.current) return
    let cancelled = false

    async function render() {
      try {
        const functionPlot = (await import("function-plot")).default
        const config = JSON.parse(spec)
        if (cancelled || !ref.current) return
        ref.current.innerHTML = ""
        functionPlot({
          target: ref.current,
          width: Math.min(ref.current.clientWidth || 500, 640),
          height: 320,
          grid: true,
          ...config,
        })
      } catch {
        if (!cancelled) setError(true)
      }
    }

    render()
    return () => { cancelled = true }
  }, [spec, done])

  if (!done) return <div className="my-3 text-xs italic text-muted-foreground/50">函数图像生成中……</div>
  if (error) return <div className="my-3 text-xs text-red-500/50">函数图像解析失败</div>

  return <div ref={ref} className="my-3 w-full overflow-x-auto [&>svg]:max-w-full" />
}
