"use client"

import { useEffect, useMemo, useRef, useState } from "react"

type Colors = { fg: string; bg: string; scheme: "light" | "dark" }

// 读取页面当前主题色，注入给 iframe，让渲染内容跟随明暗
function readTheme(): Colors {
  if (typeof document === "undefined") return { fg: "#1a1a1a", bg: "#ffffff", scheme: "light" }
  const cs = getComputedStyle(document.documentElement)
  const fg = cs.getPropertyValue("--foreground").trim() || "#1a1a1a"
  const bg = cs.getPropertyValue("--background").trim() || "#ffffff"
  const root = document.documentElement
  const dark = root.classList.contains("dark") ||
    (!root.classList.contains("light") && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  return { fg, bg, scheme: dark ? "dark" : "light" }
}

// iframe 空壳：只创建一次，之后全靠 postMessage 更新（绝不重写 srcdoc，避免重载闪烁）
function bootstrap(c: Colors): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
:root{--fg:${c.fg};--bg:${c.bg};color-scheme:${c.scheme};}
html,body{background:transparent;margin:0;padding:16px;color:var(--fg);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;box-sizing:border-box;min-height:100%;}
*{box-sizing:border-box;}#__v{width:100%;}
</style>
<script>(function(){
window.addEventListener("message",function(e){var d=e.data||{};
if(d.__art==="preview"){var v=document.getElementById("__v");if(v)v.innerHTML=d.html;}
else if(d.__art==="final"){document.open();document.write(d.html);document.close();}});
parent.postMessage({__art:"ready"},"*");
})();</script>
</head><body><div id="__v"></div></body></html>`
}

// 完成时写入完整文档：注入透明背景 + 主题变量，脚本按序执行
function prepareFinal(raw: string, c: Colors): string {
  const inject = `<style>
:root{--fg:${c.fg};--bg:${c.bg};color-scheme:${c.scheme};}
html,body{background:transparent!important;color:var(--fg);}
</style>`
  if (/<head[^>]*>/i.test(raw)) return raw.replace(/(<head[^>]*>)/i, `$1${inject}`)
  if (/<\/head>/i.test(raw)) return raw.replace(/<\/head>/i, `${inject}</head>`)
  if (/<body[^>]*>/i.test(raw)) return raw.replace(/(<body[^>]*>)/i, `$1${inject}`)
  return inject + raw
}

// 持久 iframe 渲染器：流式 preview（innerHTML，不跑脚本）→ 完成 final（document.write，跑脚本）
export function ArtifactFrame({ raw, done }: { raw: string; done: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const finalizedRef = useRef(false)
  const colors = useMemo(readTheme, [])
  const srcDoc = useMemo(() => bootstrap(colors), [colors])

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      if ((e.data || {}).__art === "ready") setReady(true)
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [])

  // 流式预览：raw 变化推送（未完成阶段，静态内容边长边现）
  useEffect(() => {
    if (!ready || done) return
    iframeRef.current?.contentWindow?.postMessage({ __art: "preview", html: raw }, "*")
  }, [raw, ready, done])

  // 完成：写入完整文档，脚本执行（图表/动画出现）
  useEffect(() => {
    if (!ready || !done || finalizedRef.current) return
    iframeRef.current?.contentWindow?.postMessage({ __art: "final", html: prepareFinal(raw, colors) }, "*")
    finalizedRef.current = true
  }, [ready, done, raw, colors])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      title="渲染"
      className="h-full w-full border-0"
      style={{ background: "transparent" }}
    />
  )
}
