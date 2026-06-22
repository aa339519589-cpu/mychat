"use client"

import { useEffect, useRef, useState } from "react"

let counter = 0

export function MermaidChart({ code, done }: { code: string; done: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState(false)
  const id = useRef(`mermaid-${++counter}`)

  useEffect(() => {
    if (!done || !code.trim() || !ref.current) return
    let cancelled = false

    async function render() {
      try {
        const mermaid = (await import("mermaid")).default
        const isDark =
          document.documentElement.classList.contains("dark") ||
          window.matchMedia("(prefers-color-scheme: dark)").matches
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "neutral",
          fontFamily: "inherit",
          fontSize: 14,
        })
        const { svg } = await mermaid.render(id.current, code.trim())
        if (!cancelled && ref.current) ref.current.innerHTML = svg
      } catch {
        if (!cancelled) setError(true)
      }
    }

    render()
    return () => { cancelled = true }
  }, [code, done])

  if (!done) return <div className="my-3 text-xs italic text-muted-foreground/50">图表生成中……</div>
  if (error) return <div className="my-3 text-xs text-red-500/50">流程图解析失败</div>

  return (
    <div
      ref={ref}
      className="my-3 w-full overflow-x-auto [&>svg]:mx-auto [&>svg]:block [&>svg]:max-w-full [&>svg]:h-auto"
    />
  )
}
