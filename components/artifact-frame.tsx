"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  artifactContentSecurityPolicy,
  createArtifactToken,
  parseArtifactFrameMessage,
  sanitizeArtifactHtml,
} from "@/lib/artifact-security"

type Colors = { fg: string; bg: string; scheme: "light" | "dark" }

const MAX_ARTIFACT_HTML_CHARS = 1_000_000

function readTheme(): Colors {
  if (typeof document === "undefined") return { fg: "#1a1a1a", bg: "#ffffff", scheme: "light" }
  const cs = getComputedStyle(document.documentElement)
  const fg = cs.getPropertyValue("--foreground").trim() || "#1a1a1a"
  const bg = cs.getPropertyValue("--background").trim() || "#ffffff"
  const root = document.documentElement
  const dark = root.classList.contains("dark") ||
    (!root.classList.contains("light") && window.matchMedia("(prefers-color-scheme: dark)").matches)
  return { fg, bg, scheme: dark ? "dark" : "light" }
}

function responsiveGuardCss(inline: boolean): string {
  return `
html,body{width:100%;max-width:100%;overflow-x:hidden;overscroll-behavior:contain;}
body{touch-action:pan-y;}
img,svg,canvas,video{max-width:100%;}
img,video,svg,canvas{height:auto;}
#__v{width:100%;max-width:100%;overflow:hidden;}
#__v>*{max-width:100%;}
@media (max-width:767px){
  html,body{min-width:0!important;}
  body{${inline ? '' : 'padding:8px!important;'}font-size:14px;}
  table{display:block;max-width:100%;overflow-x:auto;}
  pre{max-width:100%;overflow-x:auto;}
  [style*="min-width"]{min-width:0!important;}
  [style*="width"]{max-width:100%!important;}
}`
}

export function buildArtifactFrameDocument(colors: Colors, inline: boolean, token: string): string {
  const csp = artifactContentSecurityPolicy(token)
  const bodyStyle = inline
    ? `html,body{background:transparent;margin:0;padding:0;color:var(--fg);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}`
    : `html,body{background:transparent;margin:0;padding:16px;color:var(--fg);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100%;}`

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root{--fg:${colors.fg};--bg:${colors.bg};color-scheme:${colors.scheme};}
${bodyStyle}
*{box-sizing:border-box;}
${responsiveGuardCss(inline)}
</style>
<script nonce="${token}">(function(){
"use strict";
var TOKEN=${JSON.stringify(token)},port=null,previewTimer=0,previewHtml="",fitting=false;
function send(message){if(port)port.postMessage(message);}
function report(){
  var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,document.body.offsetHeight,document.body.clientHeight);
  send({type:"height",value:h});
}
function shouldFit(){return window.matchMedia&&window.matchMedia("(max-width: 767px)").matches;}
function ensureWrap(){
  var id="__artifact_mobile_fit_wrap",wrap=document.getElementById(id);
  if(wrap)return wrap;
  var view=document.getElementById("__v");
  if(!view)return null;
  wrap=document.createElement("div");
  wrap.id=id;
  wrap.style.transformOrigin="top left";
  view.parentNode.insertBefore(wrap,view);
  wrap.appendChild(view);
  return wrap;
}
function fit(){
  if(fitting)return;
  fitting=true;
  requestAnimationFrame(function(){
    fitting=false;
    var wrap=ensureWrap();
    if(!wrap)return;
    wrap.style.transform="";
    wrap.style.width="100%";
    document.body.style.minHeight="";
    if(shouldFit()){
      var viewport=document.documentElement.clientWidth||window.innerWidth||0;
      var natural=Math.max(wrap.scrollWidth,wrap.offsetWidth,document.body.scrollWidth,document.documentElement.scrollWidth);
      if(viewport&&natural>viewport+2){
        var scale=Math.max(0.35,Math.min(1,viewport/natural));
        wrap.style.width=natural+"px";
        wrap.style.transform="scale("+scale+")";
        document.body.style.minHeight=Math.ceil(wrap.scrollHeight*scale)+"px";
      }
    }
    report();
  });
}
function apply(){
  var view=document.getElementById("__v");
  if(!view)return;
  view.innerHTML=previewHtml;
  [0,80,240,800].forEach(function(delay){setTimeout(fit,delay);});
}
function receive(event){
  var message=event.data;
  if(!message||typeof message!=="object"||typeof message.html!=="string"||message.html.length>${MAX_ARTIFACT_HTML_CHARS})return;
  if(message.type==="preview"){
    previewHtml=message.html;
    if(!previewTimer)previewTimer=setTimeout(function(){previewTimer=0;apply();},120);
  }else if(message.type==="final"){
    if(previewTimer){clearTimeout(previewTimer);previewTimer=0;}
    previewHtml=message.html;
    apply();
  }
}
function connect(event){
  var message=event.data;
  if(event.source!==parent||!message||message.type!=="connect"||message.token!==TOKEN||event.ports.length!==1)return;
  window.removeEventListener("message",connect);
  port=event.ports[0];
  port.onmessage=receive;
  port.start();
  send({type:"ready"});
  report();
}
window.addEventListener("message",connect);
window.addEventListener("resize",fit);
window.addEventListener("orientationchange",fit);
if(window.ResizeObserver){try{new ResizeObserver(fit).observe(document.documentElement);}catch(error){}}
})();</script>
</head><body><div id="__v"></div></body></html>`
}

export function ArtifactFrame({
  raw, done, inline = false,
}: {
  raw: string
  done: boolean
  inline?: boolean
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const portRef = useRef<MessagePort | null>(null)
  const finalizedRef = useRef(false)
  const [height, setHeight] = useState(40)
  const [ready, setReady] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const colors = useMemo(() => readTheme(), [])
  const safeRaw = useMemo(
    () => sanitizeArtifactHtml(raw.slice(0, MAX_ARTIFACT_HTML_CHARS)),
    [raw],
  )
  const srcDoc = useMemo(
    () => token ? buildArtifactFrameDocument(colors, inline, token) : "",
    [colors, inline, token],
  )

  useEffect(() => {
    setToken(createArtifactToken())
    return () => {
      portRef.current?.close()
      portRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!done) finalizedRef.current = false
  }, [done])

  const connectFrame = useCallback(() => {
    const frame = iframeRef.current
    if (!token || !frame?.contentWindow) return
    portRef.current?.close()
    setReady(false)
    finalizedRef.current = false
    const channel = new MessageChannel()
    channel.port1.onmessage = event => {
      const message = parseArtifactFrameMessage(event.data)
      if (message?.type === "ready") setReady(true)
      else if (message?.type === "height" && inline) {
        setHeight(Math.max(40, Math.min(message.value + 4, 2400)))
      }
    }
    channel.port1.start()
    portRef.current = channel.port1
    // Sandboxed srcdoc has an opaque origin, so the one-time transferable-port
    // handshake requires "*". The embedded random token and exact window bind it.
    frame.contentWindow.postMessage({ type: "connect", token }, "*", [channel.port2])
  }, [inline, token])

  useEffect(() => {
    if (!ready || done) return
    const timer = window.setTimeout(() => {
      portRef.current?.postMessage({ type: "preview", html: safeRaw })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [safeRaw, ready, done])

  useEffect(() => {
    if (!ready || !done || finalizedRef.current) return
    portRef.current?.postMessage({ type: "final", html: safeRaw })
    finalizedRef.current = true
  }, [ready, done, safeRaw])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={connectFrame}
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
