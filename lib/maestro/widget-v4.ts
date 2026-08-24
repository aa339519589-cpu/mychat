export const MAESTRO_V4_WIDGET_URI = "ui://maestro-runner/v4-zero-code.html"

export const MAESTRO_V4_WIDGET_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 10px; background: transparent; }
    .box { border: 1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius: 16px; padding: 13px; }
    .top { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
    .title { font-size:13px; font-weight:680; }
    .sync { font-size:10px; opacity:.58; text-align:right; line-height:1.35; white-space:pre-line; }
    .objective { margin-top:8px; font-size:11px; opacity:.74; line-height:1.5; max-height:56px; overflow:auto; }
    .criterion { margin-top:7px; padding:8px 10px; border:1px solid color-mix(in srgb,currentColor 13%,transparent); border-radius:11px; font-size:10px; line-height:1.5; }
    .criterion div { margin-top:4px; white-space:pre-wrap; overflow-wrap:anywhere; }
    .stats { margin-top:10px; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; }
    .stat,.section { border:1px solid color-mix(in srgb,currentColor 13%,transparent); border-radius:12px; }
    .stat { padding:8px 6px; text-align:center; }
    .stat strong { display:block; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .stat span { display:block; margin-top:2px; font-size:9px; opacity:.58; }
    .section { margin-top:9px; padding:9px 10px; }
    .section h3 { margin:0 0 5px; font-size:10px; opacity:.62; }
    pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; font-size:11px; line-height:1.52; max-height:150px; overflow:auto; }
    .lists { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:7px; margin-top:9px; }
    ul { margin:0; padding-left:16px; font-size:10px; line-height:1.5; max-height:110px; overflow:auto; }
    details { margin-top:9px; border:1px solid color-mix(in srgb,currentColor 13%,transparent); border-radius:12px; padding:8px 10px; }
    summary { cursor:pointer; font-size:10px; opacity:.68; }
    .history { margin-top:7px; display:grid; gap:7px; max-height:320px; overflow:auto; }
    .round { border-top:1px solid color-mix(in srgb,currentColor 10%,transparent); padding-top:7px; font-size:10px; line-height:1.45; }
    .round:first-child { border-top:0; padding-top:0; }
    .round details { margin-top:4px; padding:6px 7px; }
    .round pre { font-size:9px; max-height:120px; }
    button { margin-top:9px; border:1px solid color-mix(in srgb,currentColor 22%,transparent); background:transparent; color:inherit; border-radius:9px; padding:6px 10px; font:inherit; font-size:10px; cursor:pointer; display:none; }
    @media(max-width:520px){ .stats{grid-template-columns:repeat(2,minmax(0,1fr))}.lists{grid-template-columns:1fr} }
  </style>
</head>
<body>
<div class="box">
  <div class="top"><div class="title" id="title">Maestro Runner v4</div><div class="sync" id="sync">正在接收状态…</div></div>
  <div class="objective" id="objective"></div>
  <div class="criterion"><b>不可变成功判据</b><div id="criterion"></div></div>
  <details><summary>不可变硬规则</summary><ul id="hardRules"></ul></details>

  <div class="stats">
    <div class="stat"><strong id="round">—</strong><span>当前轮</span></div>
    <div class="stat"><strong id="phase">—</strong><span>阶段</span></div>
    <div class="stat"><strong id="roundTime">0s</strong><span>本轮墙钟</span></div>
    <div class="stat"><strong id="totalTime">0s</strong><span>累计推理墙钟</span></div>
  </div>

  <div class="section"><h3>本轮输入</h3><pre id="input">等待启动…</pre></div>
  <div class="section"><h3 id="outputTitle">本轮输出</h3><pre id="output">等待输出…</pre></div>
  <div class="section"><h3>持久检查点</h3><pre id="checkpoint">暂无检查点</pre></div>

  <div class="lists">
    <div class="section" style="margin-top:0"><h3>尚未解决</h3><ul id="unresolved"></ul></div>
    <div class="section" style="margin-top:0"><h3>下一步</h3><ul id="nextActions"></ul></div>
    <div class="section" style="margin-top:0"><h3>证据</h3><ul id="evidence"></ul></div>
    <div class="section" style="margin-top:0"><h3>独立 Review 证据</h3><ul id="reviewEvidence"></ul></div>
    <div class="section" style="margin-top:0"><h3>完成门</h3><pre id="completionGate">未验证</pre></div>
    <div class="section" style="margin-top:0"><h3>任务状态</h3><pre id="statusText">等待同步…</pre></div>
  </div>

  <details><summary id="historySummary">轮次历史</summary><div class="history" id="history"></div></details>
  <button id="manual">重试自动续跑</button>
</div>
<script>
(() => {
  const $ = id => document.getElementById(id);
  let state = null;
  let syncBusy = false;
  let sendBusy = false;
  let pendingPrompt = "";
  let launchedKey = "";
  let syncFailures = 0;

  const escapeHtml = value => String(value ?? "").replace(/[&<>\"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[char]));
  const extract = result => result?.structuredContent || result?.structured_content || result?.toolOutput || result?.result?.structuredContent || null;
  const phaseLabel = value => value === "review" ? "Review" : value === "done" ? "Done" : "Work";
  const completionPassed = current => current?.status === "completed" && current?.phase === "done" && current?.completionVerified === true && current?.criterionSatisfied === true && Boolean(current?.finalAnswer);
  const statusLabel = current => completionPassed(current) ? "成功条件已验证" : current?.status === "cancelled" || current?.action === "stop" ? "已由用户停止" : current?.currentRoundStartedAt ? (current.phase === "review" ? "独立复核中" : "推理进行中") : current?.phase === "review" ? "等待独立复核" : "未完成 · 等待下一轮";
  const liveMs = current => current?.currentRoundStartedAt && Number.isFinite(Date.parse(current.currentRoundStartedAt)) ? Math.max(0, Date.now() - Date.parse(current.currentRoundStartedAt)) : 0;
  const formatMs = ms => {
    const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return h ? h + "h " + m + "m " + s + "s" : m ? m + "m " + s + "s" : s + "s";
  };
  const renderList = (id, values, empty) => {
    const rows = Array.isArray(values) && values.length ? values : [empty];
    $(id).innerHTML = rows.map(value => "<li>" + escapeHtml(value) + "</li>").join("");
  };

  function renderHistory(current) {
    const rows = Array.isArray(current?.history) ? current.history.slice().reverse() : [];
    $("historySummary").textContent = "轮次历史（" + rows.length + "）";
    if (!rows.length) {
      $("history").innerHTML = '<div class="round">还没有已完成轮次</div>';
      return;
    }
    $("history").innerHTML = rows.map(item => {
      const flags = item.completionVerified ? " · 完成门通过" : item.criterionSatisfied ? " · 条件声称满足" : "";
      const review = Array.isArray(item.reviewEvidence) && item.reviewEvidence.length
        ? '<details><summary>Review 证据</summary><pre>' + escapeHtml(item.reviewEvidence.join("\n")) + '</pre></details>'
        : '';
      return '<div class="round"><b>第 ' + escapeHtml(item.round) + ' 轮 · ' + escapeHtml(phaseLabel(item.phase)) + '</b><br>'
        + escapeHtml(formatMs(item.elapsedMs)) + ' · ' + escapeHtml(item.action) + escapeHtml(flags)
        + '<details><summary>输入</summary><pre>' + escapeHtml(item.input || "—") + '</pre></details>'
        + '<details><summary>输出</summary><pre>' + escapeHtml(item.output || "—") + '</pre></details>'
        + '<details><summary>检查点</summary><pre>' + escapeHtml(item.checkpoint || "—") + '</pre></details>'
        + review + '</div>';
    }).join("");
  }

  function render(current, source = "tool") {
    if (!current || current.kind !== "maestro-runner-state") return;
    state = current;
    const activeRound = Number(current.round || 0) + (current.currentRoundStartedAt ? 1 : 0);
    $("title").textContent = "Maestro Runner v4 · " + statusLabel(current);
    $("sync").textContent = (source === "sync" ? "已同步" : "状态已接收") + "\n" + new Date().toLocaleTimeString();
    $("objective").textContent = current.objective || "";
    $("criterion").textContent = current.successCriterion || current.objective || "";
    renderList("hardRules", current.hardRules, "暂无额外规则");
    $("round").textContent = String(activeRound);
    $("phase").textContent = phaseLabel(current.phase);
    $("input").textContent = current.currentInput || current.nextPrompt || "等待下一轮输入…";
    $("checkpoint").textContent = current.checkpoint || "暂无检查点";

    if (completionPassed(current)) {
      $("outputTitle").textContent = "最终输出 · 已通过独立复核";
      $("output").textContent = current.finalAnswer;
    } else if (current.currentRoundStartedAt) {
      $("outputTitle").textContent = "本轮输出 · 生成中";
      $("output").textContent = current.lastOutput ? "本轮尚未提交。最近已完成输出：\n\n" + current.lastOutput : "本轮正在生成，结束后自动同步。";
    } else {
      $("outputTitle").textContent = "最近已完成输出";
      $("output").textContent = current.lastOutput || "等待输出…";
    }

    renderList("unresolved", current.unresolved, "无");
    renderList("nextActions", current.nextActions, "无");
    renderList("evidence", current.evidence, "暂无");
    renderList("reviewEvidence", current.reviewEvidence, "尚未通过独立复核");
    $("completionGate").textContent = completionPassed(current)
      ? "通过\n成功判据已由独立 Review 验证"
      : "锁定\ndone=true 单独不足以结束任务";
    $("statusText").textContent = statusLabel(current)
      + "\n已完成轮次：" + Number(current.round || 0)
      + "\n成功判据：" + (current.criterionSatisfied ? "已验证" : "未验证")
      + "\n完成门：" + (current.completionVerified ? "通过" : "锁定")
      + "\n服务端更新时间：" + (current.updatedAt || "—");
    renderHistory(current);
    updateClock();
  }

  function updateClock() {
    if (!state) return;
    const live = liveMs(state);
    $("roundTime").textContent = formatMs(live);
    $("totalTime").textContent = formatMs(Number(state.totalElapsedMs || 0) + live);
  }

  async function callTool(name, args) {
    if (typeof window.openai?.callTool !== "function") throw new Error("ChatGPT tool bridge unavailable");
    return window.openai.callTool(name, args);
  }

  async function sendFollowUp(prompt) {
    if (!prompt || sendBusy) return false;
    sendBusy = true;
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          if (typeof window.openai?.sendFollowUpMessage === "function") {
            await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
            return true;
          }
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 850 + attempt * 500));
      }
      return false;
    } finally {
      sendBusy = false;
    }
  }

  async function launchIfGranted(current) {
    if (!current?.launchGranted || !current.currentInput) return;
    if (["finish","stop"].includes(current.action) || ["completed","cancelled"].includes(current.status)) return;
    const targetRound = Number(current.round || 0) + 1;
    const key = current.jobId + ":" + targetRound + ":" + (current.currentRoundStartedAt || "");
    if (launchedKey === key) return;
    launchedKey = key;
    pendingPrompt = current.currentInput || current.nextPrompt;
    $("sync").textContent = "第 " + targetRound + " 轮已锁定\n正在启动…";
    if (await sendFollowUp(pendingPrompt)) {
      pendingPrompt = "";
      $("manual").style.display = "none";
      $("sync").textContent = "第 " + targetRound + " 轮已启动\n状态持续同步";
    } else {
      $("manual").style.display = "inline-block";
      $("sync").textContent = "自动续跑未启动\n可手动重试";
    }
  }

  async function synchronize() {
    if (!state?.taskToken || syncBusy) return;
    syncBusy = true;
    try {
      const next = extract(await callTool("maestro_sync", { taskToken: state.taskToken }));
      if (next) {
        syncFailures = 0;
        render(next, "sync");
        await launchIfGranted(next);
      }
    } catch (_) {
      syncFailures += 1;
      $("sync").textContent = "状态同步暂时失败（" + syncFailures + "）\n本地计时继续";
    } finally {
      syncBusy = false;
    }
  }

  function accept(candidate) {
    if (!candidate || candidate.kind !== "maestro-runner-state") return;
    render(candidate);
    void launchIfGranted(candidate);
  }

  window.addEventListener("openai:set_globals", event => accept(event?.detail?.globals?.toolOutput || window.openai?.toolOutput), { passive:true });
  window.addEventListener("message", event => {
    const message = event.data;
    if (event.source === window.parent && message?.jsonrpc === "2.0" && message.method === "ui/notifications/tool-result") accept(message.params?.structuredContent);
  }, { passive:true });

  $("manual").addEventListener("click", async () => {
    if (pendingPrompt && await sendFollowUp(pendingPrompt)) {
      pendingPrompt = "";
      $("manual").style.display = "none";
    }
  });

  accept(window.openai?.toolOutput);
  const bootstrap = setInterval(() => { accept(window.openai?.toolOutput); if (state) clearInterval(bootstrap); }, 250);
  setTimeout(() => clearInterval(bootstrap), 15000);
  setInterval(updateClock, 1000);
  setInterval(() => { void synchronize(); }, 2500);
})();
</script>
</body>
</html>`
