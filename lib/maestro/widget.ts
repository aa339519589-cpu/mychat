export const MAESTRO_WIDGET_URI = "ui://maestro-runner/runner.html"

export const MAESTRO_WIDGET_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 10px; background: transparent; }
    .box { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 14px; padding: 12px 14px; }
    .row { display: flex; align-items: center; gap: 9px; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: currentColor; opacity: .75; }
    .title { font-weight: 650; font-size: 13px; }
    .detail { margin-top: 6px; font-size: 12px; opacity: .7; line-height: 1.45; }
    button { margin-top: 10px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: transparent; color: inherit; border-radius: 9px; padding: 6px 10px; font: inherit; cursor: pointer; display: none; }
  </style>
</head>
<body>
  <div class="box">
    <div class="row"><span class="dot"></span><span class="title" id="title">Maestro Runner</span></div>
    <div class="detail" id="detail">正在接收这一轮状态…</div>
    <button id="manual">继续下一轮</button>
  </div>
  <script>
    (() => {
      const title = document.getElementById("title");
      const detail = document.getElementById("detail");
      const manual = document.getElementById("manual");
      let handledKey = "";
      let pendingPrompt = "";
      let latestStructured = null;
      let latestMeta = null;

      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

      function compatibilityMeta() {
        const metadata = window.openai?.toolResponseMetadata;
        return metadata?.mcp_tool_result?._meta
          || metadata?.call_tool_result?._meta
          || metadata?._meta
          || null;
      }

      function stateKey(state) {
        return [state?.jobId, state?.round, state?.phase, state?.action].join(":");
      }

      async function sendFollowUp(prompt) {
        if (!prompt) return false;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            if (typeof window.openai?.sendFollowUpMessage === "function") {
              await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
              return true;
            }
          } catch (_) {}
          await sleep(1400 + attempt * 600);
        }
        return false;
      }

      async function handle(structured, meta) {
        if (!structured || structured.kind !== "maestro-runner-state") return;
        const key = stateKey(structured);
        if (!key || handledKey === key) return;
        const reportToken = meta?.reportToken;
        const reportUrl = meta?.reportUrl;
        if (!reportToken || !reportUrl) return;
        handledKey = key;
        title.textContent = structured.action === "finish" ? "Maestro Runner · 已闭环" : `Maestro Runner · 第 ${structured.round} 轮`;
        detail.textContent = "正在同步这一轮检查点…";

        try {
          const response = await fetch(reportUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: reportToken, state: structured }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
          if (result?.stop || structured.action === "finish" || structured.action === "stop") {
            detail.textContent = structured.action === "finish" ? "独立复核已通过，连续推理结束。" : "任务已停止。";
            return;
          }

          pendingPrompt = structured.nextPrompt || "";
          detail.textContent = structured.action === "review" ? "候选答案完成，正在自动开启独立复核…" : "这一轮已结束，正在自动开启下一轮…";
          await sleep(1200);
          const sent = await sendFollowUp(pendingPrompt);
          if (sent) {
            pendingPrompt = "";
            detail.textContent = structured.action === "review" ? "独立复核已启动。" : "下一轮已启动。";
          } else {
            detail.textContent = "自动续跑未能启动，点一次即可继续。";
            manual.style.display = "inline-block";
          }
        } catch (error) {
          handledKey = "";
          detail.textContent = `同步失败：${error instanceof Error ? error.message : String(error)}`;
        }
      }

      function tryCompatibilityGlobals() {
        const structured = window.openai?.toolOutput;
        const meta = compatibilityMeta();
        if (structured) latestStructured = structured;
        if (meta) latestMeta = meta;
        if (latestStructured && latestMeta) void handle(latestStructured, latestMeta);
      }

      window.addEventListener("openai:set_globals", tryCompatibilityGlobals, { passive: true });
      window.addEventListener("message", event => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/tool-result") {
          latestStructured = message.params?.structuredContent || latestStructured;
          latestMeta = message.params?._meta || latestMeta;
          if (latestStructured && latestMeta) void handle(latestStructured, latestMeta);
        }
      }, { passive: true });

      manual.addEventListener("click", async () => {
        manual.disabled = true;
        if (await sendFollowUp(pendingPrompt)) {
          manual.style.display = "none";
          pendingPrompt = "";
          detail.textContent = "下一轮已启动。";
        } else {
          manual.disabled = false;
        }
      });

      tryCompatibilityGlobals();
      const timer = setInterval(() => {
        tryCompatibilityGlobals();
        if (handledKey) clearInterval(timer);
      }, 250);
      setTimeout(() => clearInterval(timer), 15000);
    })();
  </script>
</body>
</html>`
