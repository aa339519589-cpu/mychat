"use client"

import { useEffect, useRef, useState } from "react"

let counter = 0

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return "Mermaid 语法无效或渲染器执行失败"
}

export function MermaidChart({ code, done }: { code: string; done: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const id = useRef(`mermaid-${++counter}`)

  useEffect(() => {
    setError(null)
  }, [code, done])

  useEffect(() => {
    const container = ref.current
    if (!container) return
    const element = container
    if (!done || !code.trim()) {
      element.innerHTML = ""
      return
    }

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
        if (!cancelled) {
          element.innerHTML = svg
          setError(null)
        }
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
  }, [code, done])

  if (!done) return <div className="my-3 text-xs italic text-muted-foreground/50">图表生成中……</div>
  if (error) {
    return (
      <div className="my-3 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-500/80">
        流程图显示失败：{error}
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="my-3 w-full overflow-x-auto animate-in fade-in duration-300 [&>svg]:mx-auto [&>svg]:block [&>svg]:max-w-full [&>svg]:h-auto"
    />
  )
}
