import SwiftUI
import WebKit

struct RichRendererPreview: View {
    private let sample = """
    ## 原生富文本测试

    这是 **加粗正文**、`inline code` 和一个公式：

    $$E = mc^2$$

    - 列表项目一
    - 列表项目二

    <inline-artifact>
    <svg viewBox="0 0 320 120" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="8" width="304" height="104" rx="16" fill="#F2F2F0"/>
      <path d="M35 84 L105 42 L168 75 L278 28" fill="none" stroke="#171614" stroke-width="5"/>
      <circle cx="278" cy="28" r="7" fill="#171614"/>
    </svg>
    </inline-artifact>

    <artifact>
      <h2>Artifact 预览</h2>
      <p>安全、可展开的原生容器。</p>
    </artifact>
    """

    var body: some View {
        ZStack {
            AppPalette.background.ignoresSafeArea()
            VStack(alignment: .leading, spacing: 18) {
                Text("均衡")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(maxWidth: .infinity)
                RichAssistantContent(text: sample)
                Spacer()
            }
            .padding(18)
        }
    }
}

struct RichAssistantContent: View {
    let text: String

    var body: some View {
        if needsRichRenderer {
            RichMessageWebView(content: text)
        } else {
            Text(text)
                .font(.system(size: 17))
                .lineSpacing(5)
                .textSelection(.enabled)
                .foregroundStyle(AppPalette.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var needsRichRenderer: Bool {
        let markers = [
            "**", "__", "~~", "`", "$", "# ", "## ", "- ", "* ", "> ",
            "<vega>", "<mermaid>", "<function-plot>", "<inline-artifact>", "<artifact>",
        ]
        return markers.contains(where: text.contains)
            || text.range(of: #"(?m)^\d+\.\s"#, options: .regularExpression) != nil
            || text.contains("|")
    }
}

struct NativeThinkingIndicator: View {
    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .semibold))
                .symbolEffect(.variableColor.iterative, options: .repeating)
            Text("思考中")
                .font(.system(size: 15, weight: .medium))
        }
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("模型正在思考")
    }
}

private struct RichMessageWebView: View {
    let content: String
    @State private var contentHeight: CGFloat = 32

    var body: some View {
        GeometryReader { geometry in
            RichMessageRepresentable(content: content, contentHeight: $contentHeight)
                .frame(width: geometry.size.width, height: contentHeight)
                .accessibilityLabel(content)
        }
        .frame(height: contentHeight)
    }
}

private struct RichMessageRepresentable: UIViewRepresentable {
    let content: String
    @Binding var contentHeight: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(height: $contentHeight)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(context.coordinator, name: "height")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.backgroundColor = .clear
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.setContentHuggingPriority(.required, for: .vertical)
        context.coordinator.webView = webView
        context.coordinator.pendingContent = content

        if let assetsURL = Bundle.main.resourceURL?.appending(path: "WebAssets", directoryHint: .isDirectory) {
            let rendererURL = assetsURL.appending(path: "renderer.html", directoryHint: .notDirectory)
            webView.loadFileURL(rendererURL, allowingReadAccessTo: assetsURL)
        } else {
            webView.loadHTMLString("<p>富文本资源不可用</p>", baseURL: nil)
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.scheduleRender(content)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.renderWorkItem?.cancel()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "height")
        webView.stopLoading()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var height: Binding<CGFloat>
        weak var webView: WKWebView?
        var ready = false
        var pendingContent = ""
        var renderedContent = ""
        var renderWorkItem: DispatchWorkItem?

        init(height: Binding<CGFloat>) {
            self.height = height
        }

        func scheduleRender(_ content: String) {
            pendingContent = content
            guard ready, content != renderedContent else { return }
            renderWorkItem?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.renderPendingContent() }
            renderWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: item)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            ready = true
            renderPendingContent()
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url,
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
                decisionHandler(.allow)
                return
            }
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "height",
                  let value = message.body as? Double,
                  value.isFinite else { return }
            let next = min(max(CGFloat(value), 24), 30_000)
            if abs(height.wrappedValue - next) > 0.5 {
                height.wrappedValue = next
            }
        }

        private func renderPendingContent() {
            guard ready, pendingContent != renderedContent, let webView else { return }
            renderedContent = pendingContent
            let encoded: String
            do {
                let data = try JSONEncoder().encode(pendingContent)
                encoded = String(decoding: data, as: UTF8.self)
            } catch {
                return
            }
            let command =
                "void renderMessage(\(encoded)).catch(error => {" +
                "const match=/Cannot access '([^']+)'/.exec(error.message);" +
                "document.getElementById('root').textContent = '内容显示失败：' + (match ? match[1] : error.message);" +
                "reportHeight();" +
                "});"
            webView.evaluateJavaScript(command) { _, error in
                guard error != nil else { return }
                webView.evaluateJavaScript(
                    "document.body.textContent='富文本引擎加载失败';" +
                    "webkit.messageHandlers.height.postMessage(44);"
                )
            }
        }
    }

    private static let document = #"""
    <!doctype html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' file:; style-src 'self' 'unsafe-inline' file:; font-src 'self' file:; img-src data: blob: https: file:; connect-src 'none'; media-src data: blob:; object-src 'none'; form-action 'none'">
      <link rel="stylesheet" href="katex/katex.min.css">
      <script src="marked.umd.js"></script>
      <script src="katex/katex.min.js"></script>
      <script src="katex/auto-render.min.js"></script>
      <script src="mermaid.min.js"></script>
      <script src="vega.min.js"></script>
      <script src="vega-lite.min.js"></script>
      <script src="vega-embed.min.js"></script>
      <script src="function-plot.js"></script>
      <style>
        :root{
          color-scheme:light dark;
          --text:#151412;--secondary:#686763;--muted:#777;
          --fill:#f1f1ef;--soft-fill:#f7f7f5;--border:rgba(0,0,0,.1);
          --quote:#c8c7c3;--error:#8a3a32;--error-fill:#fff5f3;--error-border:#efd5d0;
        }
        *{box-sizing:border-box}
        html,body{margin:0;padding:0;background:transparent;color:var(--text)}
        body{-webkit-text-size-adjust:100%;font:500 17px/1.58 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;overflow:hidden;overflow-wrap:anywhere}
        #root{width:100%;padding:0 0 1px}
        p{margin:0 0 11px} p:last-child{margin-bottom:0}
        h1,h2,h3,h4{line-height:1.25;margin:20px 0 9px;font-weight:700;letter-spacing:-.01em}
        h1{font-size:26px} h2{font-size:23px} h3{font-size:20px} h4{font-size:18px}
        ul,ol{margin:7px 0 12px;padding-left:23px} li{margin:4px 0}
        strong{font-weight:750} em{font-style:italic} del{color:var(--muted)}
        a{color:inherit;text-decoration:underline;text-underline-offset:3px}
        code{font:500 .86em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--fill);border-radius:5px;padding:2px 5px}
        pre{margin:12px 0;overflow:auto;background:var(--fill);border:1px solid var(--border);border-radius:10px;padding:13px}
        pre code{padding:0;background:transparent;white-space:pre;font-size:13px}
        blockquote{margin:12px 0;padding:4px 0 4px 13px;border-left:3px solid var(--quote);color:var(--secondary)}
        hr{border:0;border-top:1px solid var(--border);margin:20px 0}
        table{display:block;max-width:100%;overflow:auto;border-collapse:collapse;margin:12px 0;font-size:14px}
        th,td{border:1px solid var(--border);padding:7px 9px;text-align:left} th{background:var(--fill)}
        img,svg,canvas{display:block;max-width:100%;height:auto;margin:10px auto}
        .katex-display{overflow-x:auto;overflow-y:hidden;padding:6px 0}
        .complex{margin:13px 0;max-width:100%;overflow:hidden}
        .pending{color:var(--muted);font-size:14px}
        .error{color:var(--error);background:var(--error-fill);border:1px solid var(--error-border);border-radius:9px;padding:9px 11px}
        .artifact-button{width:100%;min-height:48px;border:1px solid var(--border);border-radius:12px;background:var(--soft-fill);color:var(--text);text-align:left;padding:12px 14px;font:600 15px -apple-system,BlinkMacSystemFont,sans-serif}
        .artifact-preview{display:none;margin-top:8px;max-height:520px;overflow:auto;border:1px solid var(--border);border-radius:12px;padding:12px;background:var(--soft-fill)}
        @media (prefers-color-scheme:dark){
          :root{
            --text:#f2f2f2;--secondary:#aaa9a5;--muted:#949391;
            --fill:#242426;--soft-fill:#1c1c1e;--border:rgba(255,255,255,.13);
            --quote:#555558;--error:#ffb4aa;--error-fill:#2d1d1b;--error-border:#5b3330;
          }
        }
      </style>
    </head>
    <body><main id="root"></main>
    <script>
      marked.setOptions({gfm:true,breaks:true});
      mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:"neutral",fontFamily:"-apple-system,BlinkMacSystemFont,sans-serif"});
      const tags=[
        ["vega","<vega>","</vega>"],["mermaid","<mermaid>","</mermaid>"],
        ["function","<function-plot>","</function-plot>"],
        ["svg","<inline-artifact>","</inline-artifact>"],["artifact","<artifact>","</artifact>"]
      ];
      let renderID=0;
      function sanitize(container){
        container.querySelectorAll("script,iframe,object,embed,form,link,meta,base").forEach(n=>n.remove());
        container.querySelectorAll("*").forEach(node=>{
          [...node.attributes].forEach(attr=>{
            const n=attr.name.toLowerCase(),v=attr.value.trim();
            if(n.startsWith("on")||n==="srcdoc"||n==="nonce"||/javascript:/i.test(v))node.removeAttribute(attr.name);
            if(["href","src","xlink:href"].includes(n)&&!(/^https:\/\//i.test(v)||/^#/.test(v)||/^data:image\//i.test(v)))node.removeAttribute(attr.name);
          });
        });
      }
      function parts(raw){
        const out=[];let cursor=0;
        while(cursor<raw.length){
          let found=null;
          for(const t of tags){const i=raw.indexOf(t[1],cursor);if(i>=0&&(!found||i<found.i))found={t,i};}
          if(!found){out.push({kind:"text",raw:raw.slice(cursor)});break;}
          if(found.i>cursor)out.push({kind:"text",raw:raw.slice(cursor,found.i)});
          const start=found.i+found.t[1].length,end=raw.indexOf(found.t[2],start);
          out.push({kind:found.t[0],raw:raw.slice(start,end<0?raw.length:end),done:end>=0});
          cursor=end<0?raw.length:end+found.t[2].length;
        }
        return out;
      }
      function markdown(raw){
        const host=document.createElement("section");
        host.innerHTML=marked.parse(raw);
        sanitize(host);
        renderMathInElement(host,{throwOnError:false,strict:false,delimiters:[
          {left:"$$",right:"$$",display:true},{left:"\\[",right:"\\]",display:true},
          {left:"\\(",right:"\\)",display:false},{left:"$",right:"$",display:false}
        ]});
        return host;
      }
      async function complex(part,root){
        const host=document.createElement("section");host.className="complex";root.appendChild(host);
        if(!part.done&&part.kind!=="svg"){host.className+=" pending";host.textContent="生成中…";return;}
        try{
          if(part.kind==="svg"){host.innerHTML=part.raw+(part.raw.includes("</svg>")?"":"</svg>");sanitize(host);}
          else if(part.kind==="mermaid"){const r=await mermaid.render("m"+(++renderID),part.raw.trim());host.innerHTML=r.svg;sanitize(host);}
          else if(part.kind==="vega"){const spec=JSON.parse(part.raw);spec.width="container";spec.background="transparent";await vegaEmbed(host,spec,{actions:false,renderer:"svg"});}
          else if(part.kind==="function"){
            const spec=JSON.parse(part.raw);functionPlot({...spec,target:host,width:Math.max(270,root.clientWidth),height:240,grid:true});
          }else{
            const button=document.createElement("button");button.className="artifact-button";button.textContent="打开作品";
            const preview=document.createElement("div");preview.className="artifact-preview";preview.innerHTML=part.raw;sanitize(preview);
            button.onclick=()=>{preview.style.display=preview.style.display==="block"?"none":"block";reportHeight();};
            host.append(button,preview);
          }
        }catch(error){host.className+=" error";host.textContent="内容显示失败："+(error&&error.message?error.message:"格式无效");}
      }
      async function renderMessage(raw){
        const root=document.getElementById("root");root.replaceChildren();
        for(const part of parts(raw)){if(part.kind==="text"){if(part.raw.trim())root.appendChild(markdown(part.raw));}else await complex(part,root);}
        reportHeight();
      }
      let heightTimer=0;
      function reportHeight(){clearTimeout(heightTimer);heightTimer=setTimeout(()=>webkit.messageHandlers.height.postMessage(Math.ceil(document.documentElement.scrollHeight)),20);}
      new ResizeObserver(reportHeight).observe(document.body);
      window.addEventListener("load",reportHeight);
    </script></body></html>
    """#
}
