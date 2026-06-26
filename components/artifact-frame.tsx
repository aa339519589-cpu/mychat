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

function responsiveGuardCss(inline: boolean): string {
  return `
html,body{width:100%;max-width:100%;overflow-x:hidden;overscroll-behavior:contain;}
body{touch-action:pan-y;}
img,svg,canvas,video{max-width:100%;}
img,video{height:auto;}
svg{height:auto;}
canvas{height:auto;}
#__v{width:100%;max-width:100%;overflow:hidden;}
#__v>*{max-width:100%;}
@media (max-width:767px){
  html,body{min-width:0!important;}
  body{${inline ? '' : 'padding:8px!important;'}font-size:14px;}
  table{display:block;max-width:100%;overflow-x:auto;}
  pre{max-width:100%;overflow-x:auto;}
  [style*="min-width"]{min-width:0!important;}
  [style*="width"]{max-width:100%!important;}
}
`
}

function mobileFitScript(): string {
  return `
<script>(function(){
var WRAP_ID="__artifact_mobile_fit_wrap";
var fitting=false;
function shouldFit(){return window.matchMedia&&window.matchMedia("(max-width: 767px)").matches;}
function ensureWrap(){
  if(!document.body) return null;
  var wrap=document.getElementById(WRAP_ID);
  if(wrap) return wrap;
  wrap=document.createElement("div");
  wrap.id=WRAP_ID;
  wrap.style.transformOrigin="top left";
  while(document.body.firstChild) wrap.appendChild(document.body.firstChild);
  document.body.appendChild(wrap);
  return wrap;
}
function fit(){
  if(fitting) return;
  fitting=true;
  requestAnimationFrame(function(){
    fitting=false;
    var wrap=ensureWrap();
    if(!wrap) return;
    wrap.style.transform="";
    wrap.style.width="100%";
    document.body.style.overflowX="hidden";
    document.documentElement.style.overflowX="hidden";
    document.body.style.minHeight="";
    if(!shouldFit()) return;
    var vw=document.documentElement.clientWidth||window.innerWidth||0;
    if(!vw) return;
    var natural=Math.max(wrap.scrollWidth,wrap.offsetWidth,document.body.scrollWidth,document.documentElement.scrollWidth);
    if(natural<=vw+2) return;
    var scale=Math.max(0.35,Math.min(1,vw/natural));
    wrap.style.width=natural+"px";
    wrap.style.transform="scale("+scale+")";
    document.body.style.minHeight=Math.ceil(wrap.scrollHeight*scale)+"px";
  });
}
window.addEventListener("load",function(){fit();[120,360,900,1800].forEach(function(t){setTimeout(fit,t);});});
window.addEventListener("resize",fit);
window.addEventListener("orientationchange",fit);
if(window.ResizeObserver){try{new ResizeObserver(fit).observe(document.documentElement);}catch(e){}}
})();</script>`
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
*{box-sizing:border-box;}
${responsiveGuardCss(inline)}
</style>
<script>(function(){
${heightScript}
var __previewTimer=0,__previewHtml="";
function __applyPreview(){var v=document.getElementById("__v");if(v){v.innerHTML=__previewHtml;${inline ? 'if(typeof __report==="function")setTimeout(__report,80);' : ''}}}
window.addEventListener("message",function(e){var d=e.data||{};
if(d.__art==="preview"){
  __previewHtml=d.html||"";
  if(!__previewTimer){__previewTimer=setTimeout(function(){__previewTimer=0;__applyPreview();},120);}
}
else if(d.__art==="final"){document.open();document.write(d.html);document.close();}});
parent.postMessage({__art:"ready"},"*");
})();</script>
</head><body><div id="__v"></div></body></html>`
}

// 完成时写入完整文档（注入主题变量 + 可选的高度上报脚本 + 移动端缩放保护）
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
*{box-sizing:border-box;}
${responsiveGuardCss(inline)}
</style>${heightScript}${mobileFitScript()}`
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

  // 流式预览：降频写入 iframe，避免模型生成 artifact 时拖住主线程和滚动。
  useEffect(() => {
    if (!ready || done) return
    const timer = window.setTimeout(() => {
      iframeRef.current?.contentWindow?.postMessage({ __art: "preview", html: raw }, "*")
    }, 80)
    return () => window.clearTimeout(timer)
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
