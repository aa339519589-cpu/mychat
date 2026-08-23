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

      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

      async function handle(structured) {
        if (!structured || structured.kind !== "maestro-runner-state") return;
        const key = stateKey(structured);
        if (!key || handledKey === key) return;
        handledKey = key;

        title.textContent = structured.action === "finish"
          ? "Maestro Runner · 已闭环"
          : "Maestro Runner · 第 " + structured.round + " 轮";

        if (structured.action === "finish" || structured.action === "stop") {
          detail.textContent = structured.action === "finish"
            ? "独立复核已通过，连续推理结束。"
            : "任务已停止。";
          return;
        }

        pendingPrompt = structured.nextPrompt || "";
        if (!pendingPrompt) {
          handledKey = "";
          detail.textContent = "缺少下一轮提示，无法续跑。";
          return;
        }

        detail.textContent = structured.action === "review"
          ? "候选答案完成，正在自动开启独立复核…"
          : "这一轮已持久化，正在自动开启下一轮…";

        await sleep(900);
        const sent = await sendFollowUp(pendingPrompt);
        if (sent) {
          pendingPrompt = "";
          detail.textContent = structured.action === "review"
            ? "独立复核已启动。"
            : "下一轮已启动。";
        } else {
          detail.textContent = "自动续跑未能启动，点一次即可继续。";
          manual.style.display = "inline-block";
        }
      }

      function tryCompatibilityGlobals() {
        const structured = window.openai?.toolOutput;
        if (structured) latestStructured = structured;
        if (latestStructured) void handle(latestStructured);
      }

      window.addEventListener("openai:set_globals", tryCompatibilityGlobals, { passive: true });
      window.addEventListener("message", event => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/tool-result") {
          latestStructured = message.params?.structuredContent || latestStructured;
          if (latestStructured) void handle(latestStructured);
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