export const MAESTRO_WIDGET_URI = "ui://maestro-runner/runner.html"

export const MAESTRO_WIDGET_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 10px; background: transparent; }
    .box { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 16px; padding: 13px; }
    .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .row { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: currentColor; opacity: .78; flex: 0 0 auto; }
    .title { font-weight: 680; font-size: 13px; }
    .sync { font-size: 10px; opacity: .58; text-align: right; line-height: 1.35; }
    .objective { margin-top: 8px; font-size: 11px; opacity: .72; line-height: 1.5; max-height: 52px; overflow: auto; }
    .stats { margin-top: 11px; display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 6px; }
    .stat { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 11px; padding: 8px 6px; text-align: center; min-width: 0; }
    .stat strong { display: block; font-size: 13px; font-weight: 680; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stat span { display: block; margin-top: 2px; font-size: 9px; opacity: .58; }
    .section { margin-top: 9px; border: 1px solid color-mix(in srgb, currentColor 13%, transparent); border-radius: 12px; padding: 9px 10px; }
    .section h3 { margin: 0 0 5px; font-size: 10px; font-weight: 650; opacity: .62; }
    .content { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 1.52; max-height: 150px; overflow: auto; }
    .muted { opacity: .58; }
    .lists { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; margin-top: 9px; }
    ul { margin: 0; padding-left: 16px; font-size: 10px; line-height: 1.5; max-height: 105px; overflow: auto; }
    details.history { margin-top: 9px; border: 1px solid color-mix(in srgb, currentColor 13%, transparent); border-radius: 12px; padding: 8px 10px; }
    summary { cursor: pointer; font-size: 10px; font-weight: 650; opacity: .68; }
    .history-list { margin-top: 7px; display: grid; gap: 6px; max-height: 250px; overflow: auto; }
    .round { border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent); padding-top: 6px; }
    .round:first-child { border-top: 0; padding-top: 0; }
    .round-head { font-size: 10px; font-weight: 650; }
    .round-meta { margin-top: 2px; font-size: 9px; opacity: .55; }
    .round details { margin-top: 4px; }
    .round details summary { font-size: 9px; }
    .round pre { margin: 5px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 9px; line-height: 1.45; max-height: 110px; overflow: auto; }
    button { margin-top: 9px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: transparent; color: inherit; border-radius: 9px; padding: 6px 10px; font: inherit; font-size: 10px; cursor: pointer; display: none; }
    @media (max-width: 520px) { .stats { grid-template-columns: repeat(2,minmax(0,1fr)); } .lists { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="box">
    <div class="top">
      <div class="row"><span class="dot"></span><span class="title" id="title">Maestro Runner</span></div>
      <div class="sync" id="sync">正在接收状态…</div>
    </div>
    <div class="objective" id="objective"></div>

    <div class="stats">
      <div class="stat"><strong id="currentRound">—</strong><span>当前轮</span></div>
      <div class="stat"><strong id="phase">—</strong><span>阶段</span></div>
      <div class="stat"><strong id="roundTime">0s</strong><span>本轮墙钟</span></div>
      <div class="stat"><strong id="totalTime">0s</strong><span>累计推理墙钟</span></div>
    </div>

    <div class="section"><h3>本轮输入</h3><pre class="content" id="input">等待启动…</pre></div>
    <div class="section"><h3 id="outputTitle">本轮输出</h3><pre class="content" id="output">等待本轮输出…</pre></div>
    <div class="section"><h3>持久检查点</h3><pre class="content muted" id="checkpoint">暂无检查点</pre></div>

    <div class="lists">
      <div class="section" style="margin-top:0"><h3>尚未解决</h3><ul id="unresolved"></ul></div>
      <div class="section" style="margin-top:0"><h3>下一步</h3><ul id="nextActions"></ul></div>
      <div class="section" style="margin-top:0"><h3>证据</h3><ul id="evidence"></ul></div>
      <div class="section" style="margin-top:0"><h3>状态</h3><pre class="content" id="statusText">等待同步…</pre></div>
    </div>

    <details class="history"><summary id="historySummary">轮次历史</summary><div class="history-list" id="history"></div></details>
    <button id="manual">重试自动续跑</button>
  </div>
  <script>
    (() => {
      const $ = id => document.getElementById(id);
      const title = $("title");
      const sync = $("sync");
      const objective = $("objective");
      const currentRound = $("currentRound");
      const phase = $("phase");
      const roundTime = $("roundTime");
      const totalTime = $("totalTime");
      const input = $("input");
      const output = $("output");
      const outputTitle = $("outputTitle");
      const checkpoint = $("checkpoint");
      const unresolved = $("unresolved");
      const nextActions = $("nextActions");
      const evidence = $("evidence");
      const statusText = $("statusText");
      const historySummary = $("historySummary");
      const history = $("history");
      const manual = $("manual");

      let state = null;
      let pollBusy = false;
      let followupBusy = false;
      let pendingPrompt = "";
      let pollFailures = 0;
      let lastSyncAt = 0;
      let launchedKey = "";

      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const esc = value => String(value ?? "").replace(/[&<>\"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[ch]));

      function formatMs(ms) {
        const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h) return h + "h " + m + "m " + s + "s";
        if (m) return m + "m " + s + "s";
        return s + "s";
      }

      function phaseLabel(value) {
        return value === "review" ? "Review" : value === "done" ? "Done" : "Work";
      }

      function list(el, items, empty) {
        const values = Array.isArray(items) ? items : [];
        el.innerHTML = values.length ? values.map(item => "<li>" + esc(item) + "</li>").join("") : "<li class=\"muted\">" + esc(empty) + "</li>";
      }

      function extractStructured(result) {
        return result?.structuredContent
          || result?.structured_content
          || result?.toolOutput
          || result?.result?.structuredContent
          || null;
      }

      function liveRoundElapsed(current) {
        if (!current?.currentRoundStartedAt) return 0;
        const start = Date.parse(current.currentRoundStartedAt);
        return Number.isFinite(start) ? Math.max(0, Date.now() - start) : 0;
      }

      function statusLabel(current) {
        if (current?.status === "completed" || current?.phase === "done") return "已完成";
        if (current?.status === "cancelled" || current?.action === "stop") return "已停止";
        if (current?.status === "failed") return "失败";
        if (current?.currentRoundStartedAt) return current.phase === "review" ? "独立复核进行中" : "推理进行中";
        return current?.phase === "review" ? "等待独立复核" : "等待下一轮";
      }

      function renderHistory(current) {
        const rows = Array.isArray(current?.history) ? current.history.slice().reverse() : [];
        historySummary.textContent = "轮次历史（" + rows.length + "）";
        if (!rows.length) {
          history.innerHTML = '<div class="muted" style="font-size:10px">还没有已完成轮次</div>';
          return;
        }
        history.innerHTML = rows.map(item => {
          return '<div class="round">'
            + '<div class="round-head">第 ' + esc(item.round) + ' 轮 · ' + esc(phaseLabel(item.phase)) + '</div>'
            + '<div class="round-meta">' + esc(formatMs(item.elapsedMs)) + ' · ' + esc(item.action) + '</div>'
            + '<details><summary>输入</summary><pre>' + esc(item.input || "—") + '</pre></details>'
            + '<details><summary>输出</summary><pre>' + esc(item.output || "—") + '</pre></details>'
            + '<details><summary>检查点</summary><pre>' + esc(item.checkpoint || "—") + '</pre></details>'
            + '</div>';
        }).join("");
      }

      function render(current, source = "tool") {
        if (!current || current.kind !== "maestro-runner-state") return;
        state = current;
        lastSyncAt = Date.now();
        const activeRound = current.currentRoundStartedAt ? Number(current.round || 0) + 1 : Number(current.round || 0);
        title.textContent = "Maestro Runner · " + statusLabel(current);
        objective.textContent = current.objective || "";
        currentRound.textContent = activeRound || "0";
        phase.textContent = phaseLabel(current.phase);
        input.textContent = current.currentInput || current.nextPrompt || "等待下一轮输入…";
        checkpoint.textContent = current.checkpoint || "暂无检查点";
        const running = Boolean(current.currentRoundStartedAt) && current.status !== "completed";
        if (current.finalAnswer) {
          outputTitle.textContent = "最终输出";
          output.textContent = current.finalAnswer;
        } else if (running) {
          outputTitle.textContent = "本轮输出 · 生成中";
          output.textContent = current.lastOutput ? "本轮尚未提交。最近已完成输出：\n\n" + current.lastOutput : "本轮正在生成，结束后自动同步到这里。";
        } else {
          outputTitle.textContent = "最近已完成输出";
          output.textContent = current.lastOutput || "等待本轮输出…";
        }
        list(unresolved, current.unresolved, "无");
        list(nextActions, current.nextActions, "无");
        list(evidence, current.evidence, "暂无");
        statusText.textContent = statusLabel(current) + "\n已完成轮次：" + Number(current.round || 0) + "\n服务端更新时间：" + (current.updatedAt || "—");
        renderHistory(current);
        updateClock();
        sync.textContent = (source === "poll" ? "已同步" : "状态已接收") + "\n" + new Date(lastSyncAt).toLocaleTimeString();
        manual.style.display = pendingPrompt ? "inline-block" : "none";
      }

      function updateClock() {
        if (!state) return;
        const live = liveRoundElapsed(state);
        roundTime.textContent = formatMs(live);
        totalTime.textContent = formatMs(Number(state.totalElapsedMs || 0) + live);
      }

      async function callTool(name, args) {
        if (typeof window.openai?.callTool !== "function") throw new Error("ChatGPT tool bridge unavailable");
        return window.openai.callTool(name, args);
      }

      async function sendFollowUp(prompt) {
        if (!prompt || followupBusy) return false;
        followupBusy = true;
        try {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              if (typeof window.openai?.sendFollowUpMessage === "function") {
                await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
                return true;
              }
            } catch (_) {}
            await sleep(900 + attempt * 500);
          }
          return false;
        } finally {
          followupBusy = false;
        }
      }

      async function maybeLaunch(current) {
        if (!current?.launchGranted || !current.currentInput) return;
        if (current.action === "finish" || current.action === "stop" || current.status === "completed" || current.status === "cancelled") return;
        const targetRound = Number(current.round || 0) + 1;
        const key = current.jobId + ":" + targetRound + ":" + (current.currentRoundStartedAt || "");
        if (launchedKey === key) return;
        launchedKey = key;
        pendingPrompt = current.currentInput || current.nextPrompt;
        sync.textContent = "已锁定第 " + targetRound + " 轮\n正在启动…";
        const sent = await sendFollowUp(pendingPrompt);
        if (sent) {
          pendingPrompt = "";
          manual.style.display = "none";
          sync.textContent = "第 " + targetRound + " 轮已启动\n状态持续同步";
        } else {
          sync.textContent = "自动续跑未启动\n可手动重试";
          manual.style.display = "inline-block";
        }
      }

      async function refreshStatus() {
        if (!state?.startCode || pollBusy) return;
        pollBusy = true;
        try {
          const result = await callTool("maestro_start", { startCode: state.startCode });
          const next = extractStructured(result);
          if (next) {
            pollFailures = 0;
            render(next, "poll");
            await maybeLaunch(next);
          }
        } catch (error) {
          pollFailures += 1;
          sync.textContent = "状态同步暂时失败（" + pollFailures + "）\n本地计时继续";
        } finally {
          pollBusy = false;
        }
      }

      function acceptHostState(candidate) {
        if (!candidate || candidate.kind !== "maestro-runner-state") return;
        render(candidate, "tool");
        void maybeLaunch(candidate);
      }

      function readHostGlobals(event) {
        const globals = event?.detail?.globals;
        acceptHostState(globals?.toolOutput || window.openai?.toolOutput);
      }

      window.addEventListener("openai:set_globals", readHostGlobals, { passive: true });
      window.addEventListener("message", event => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.method === "ui/notifications/tool-result") acceptHostState(message.params?.structuredContent);
      }, { passive: true });

      manual.addEventListener("click", async () => {
        if (!pendingPrompt) return;
        manual.disabled = true;
        if (await sendFollowUp(pendingPrompt)) {
          pendingPrompt = "";
          manual.style.display = "none";
          sync.textContent = "续跑已启动\n状态持续同步";
        }
        manual.disabled = false;
      });

      acceptHostState(window.openai?.toolOutput);
      const bootstrap = setInterval(() => {
        acceptHostState(window.openai?.toolOutput);
        if (state) clearInterval(bootstrap);
      }, 250);
      setTimeout(() => clearInterval(bootstrap), 15000);
      setInterval(updateClock, 1000);
      setInterval(() => { void refreshStatus(); }, 2500);
    })();
  </script>
</body>
</html>`
