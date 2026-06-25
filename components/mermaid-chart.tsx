"use client"

import { useEffect, useRef, useState } from "react"
import { VisualReveal } from "@/components/visual-reveal"

let counter = 0

const MERMAID_THEME = {
  background: "#FBF7EF",
  primaryColor: "#FFF1D9",
  primaryTextColor: "#2B221C",
  primaryBorderColor: "#D9782F",
  secondaryColor: "#E4F1F4",
  tertiaryColor: "#F7DCE2",
  secondaryBorderColor: "#2F8CA3",
  tertiaryBorderColor: "#B34C63",
  lineColor: "#7A644B",
  edgeLabelBackground: "#FBF7EF",
  clusterBkg: "#F4EBDD",
  clusterBorder: "#D5C4AA",
  mainBkg: "#FFF8EC",
}

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
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          themeVariables: MERMAID_THEME,
          themeCSS: "svg{background:transparent;} .edgeLabel{color:#2B221C;}",
          fontFamily: "inherit",
          fontSize: 14,
        })
        const { svg } = await mermaid.render(id.current, code.trim())
        if (!cancelled) {
          element.innerHTML = svg
          const rendered = element.querySelector("svg")
          if (rendered) {
            rendered.style.width = "100%"
            rendered.style.height = "auto"
            rendered.style.maxWidth = "100%"
          }
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
    <VisualReveal ready={done && !error && !!code.trim()} signature={code} className="my-3 w-full">
      <div className="visual-surface rounded-[1.55rem] p-4 md:p-5">
        <div
          ref={ref}
          className="w-full overflow-x-auto [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:max-w-full"
        />
      </div>
    </VisualReveal>
  )
}
