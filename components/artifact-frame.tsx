"use client"

import { useEffect, useMemo, useRef, useState } from "react"

type Colors = { fg: string; bg: string; scheme: "light" | "dark" }

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

// 内联模式：透明背景，高度自适应，ResizeObserver 上报
// 面板模式：铺满容器，背景由面板控制
function bootstrap(c: Colors, inline: boolean): string {
  const heightScript = inline ? `
function __report(){
  var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,document.body.offsetHeight,document.body.clientHeight);
  parent.postMessage({__art:"h",v:h},"*");
}
if(window.ResizeObserver){try{new ResizeObserver(__report).observe(document.body);}catch(e){}}
window.addEventListener("load",function(){__report();[200,600,1500].forEach(function(t){setTimeout(__report,t);});});
` : ''
  const bodyStyle = inline
    ? `html,body{background:transparent;margin:0;padding:0;color:var(--fg);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}`
    : `html,body{background:transparent;margin:0;padding:16px;color:var(--fg);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100%;}`

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
:root{--fg:${c.fg};--bg:${c.bg};color-scheme:${c.scheme};}
${bodyStyle}
*{box-sizing:border-box;}#__v{width:100%;}
</style>
<script>(function(){
${heightScript}
window.addEventListener("message",function(e){var d=e.data||{};
if(d.__art==="preview"){var v=document.getElementById("__v");if(v){v.innerHTML=d.html;${inline ? 'if(typeof __report==="function")setTimeout(__report,80);' : ''}}}
else if(d.__art==="final"){document.open();document.write(d.html);document.close();}});
parent.postMessage({__art:"ready"},"*");
})();</script>
</head><body><div id="__v"></div></body></html>`
}

// 完成时写入完整文档（注入主题变量 + 可选的高度上报脚本）
function prepareFinal(raw: string, c: Colors, inline: boolean): string {
  const heightScript = inline ? `
<script>(function(){
function __report(){var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,document.body.offsetHeight);parent.postMessage({__art:"h",v:h},"*");}
if(window.ResizeObserver){try{new ResizeObserver(__report).observe(document.body);}catch(e){}}
window.addEventListener("load",function(){__report();[300,800,2000].forEach(function(t){setTimeout(__report,t);});});
})();</script>` : ''
  const inject = `<style>
:root{--fg:${c.fg};--bg:${c.bg};color-scheme:${c.scheme};}
html,body{background:transparent!important;${inline ? 'margin:0;padding:0;' : ''}color:var(--fg);}
</style>${heightScript}`
  if (/<head[^>]*>/i.test(raw)) return raw.replace(/(<head[^>]*>)/i, `$1${inject}`)
  if (/<\/head>/i.test(raw)) return raw.replace(/<\/head>/i, `${inject}</head>`)
  if (/<body[^>]*>/i.test(raw)) return raw.replace(/(<body[^>]*>)/i, `$1${inject}`)
  return inject + raw
}

export function ArtifactFrame({
  raw, done, inline = false,
}: {
  raw: string
  done: boolean
  inline?: boolean
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(40)
  const [ready, setReady] = useState(false)
  const finalizedRef = useRef(false)
  const colors = useMemo(() => readTheme(), [])
  const srcDoc = useMemo(() => bootstrap(colors, inline), [colors, inline])

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      const d = e.data || {}
      if (d.__art === "ready") setReady(true)
      else if (d.__art === "h" && typeof d.v === "number") {
        if (inline) setHeight(Math.max(40, Math.min(d.v + 4, 2400)))
      }
    }
    window.addEventListener("message", onMsg)
    return () => window.removeEventListener("message", onMsg)
  }, [inline])

  // 流式预览：静态内容边生成边显现
  useEffect(() => {
    if (!ready || done) return
    iframeRef.current?.contentWindow?.postMessage({ __art: "preview", html: raw }, "*")
  }, [raw, ready, done])

  // 完成：document.write 完整文档，CDN 脚本执行
  useEffect(() => {
    if (!ready || !done || finalizedRef.current) return
    iframeRef.current?.contentWindow?.postMessage({ __art: "final", html: prepareFinal(raw, colors, inline) }, "*")
    finalizedRef.current = true
  }, [ready, done, raw, colors, inline])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      title="渲染"
      scrolling={inline ? "no" : "auto"}
      className="w-full border-0"
      style={{
        background: "transparent",
        display: "block",
        height: inline ? height : "100%",
      }}
    />
  )
}
