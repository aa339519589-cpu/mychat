"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronLeft, Loader2, Check, X, ExternalLink, GitBranch, CornerDownLeft, Trash2, Plus, FilePlus2, FileEdit, Rocket, FolderGit2, ChevronDown, Square } from "lucide-react"
import { cn } from "@/lib/utils"
import { type Tier, CODE_TIERS } from "@/lib/chat-data"
import {
  type CodeMessage, type CodeStep, type CodeSession, type CodeMemory, type PlanAction, type ApplyResult,
  fetchCodeSessions, createCodeSession, touchCodeSession,
  fetchCodeMessages, insertCodeMessage,
  fetchCodeMemories, insertCodeMemory, deleteCodeMemory,
} from "@/lib/code-data"
import { WorkingDots } from "@/components/working-dots"
import { AgentTasksPanel } from "@/components/agent-tasks-panel"
import ReactMarkdown from "react-markdown"
import remarkMath from "remark-math"
import remarkGfm from "remark-gfm"
import rehypeKatex from "rehype-katex"
import { stripToolMarkup } from "@/lib/llm/sanitize"

const MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace"
const ACCENT = "var(--code-accent)"  // 亮色=Claude橙 oklch(0.62 0.15 38)；暗色=蓝 oklch(0.52 0.12 256)；在 globals.css 定义

type RepoItem = { name: string; full_name: string; private: boolean; description: string }
type Overlay = null | "model" | "memory" | "resume" | "context" | "tasks"

const COMMANDS = [
  { cmd: "/new", desc: "在当前项目内开启新对话" },
  { cmd: "/model", desc: "切换模型（快速 / 均衡 / 深度）" },
  { cmd: "/memory", desc: "查看 / 编辑本仓库的记忆" },
  { cmd: "/context", desc: "查看当前上下文用量" },
  { cmd: "/resume", desc: "恢复本仓库的历史排查" },
  { cmd: "/goal", desc: "设定目标，让它自主多轮完成" },
  { cmd: "/tasks", desc: "查看 Agent 任务列表与状态" },
]

// ── 行级 diff（LCS）──
type DiffLine = { type: "same" | "add" | "del"; text: string }
function computeDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n"), b = newText.split("\n")
  if (a.length > 600 || b.length > 600) {
    return [...a.map(t => ({ type: "del" as const, text: t })), ...b.map(t => ({ type: "add" as const, text: t }))]
  }
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  const out: DiffLine[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) { out.unshift({ type: "same", text: a[i - 1] }); i--; j-- }
    else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) { out.unshift({ type: "add", text: b[j - 1] }); j-- }
    else { out.unshift({ type: "del", text: a[i - 1] }); i-- }
  }
  return out
}

function DiffBody({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const lines = computeDiff(oldContent, newContent)
  return (
    <div className="max-h-[300px] overflow-auto" style={{ fontFamily: MONO, fontSize: "11px", lineHeight: "1.65" }}>
      {lines.map((ln, idx) => (
        <div key={idx} className="flex" style={{
          background: ln.type === "add" ? "color-mix(in oklab, #3fb950 16%, transparent)" : ln.type === "del" ? "color-mix(in oklab, #f85149 14%, transparent)" : undefined,
          borderLeft: ln.type === "add" ? "2px solid #3fb950" : ln.type === "del" ? "2px solid #f85149" : "2px solid transparent",
        }}>
          <span className="shrink-0 select-none px-2 text-center text-muted-foreground/60" style={{ width: 18 }}>
            {ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}
          </span>
          <span className="whitespace-pre-wrap break-all pr-2 text-foreground/85">{ln.text || " "}</span>
        </div>
      ))}
    </div>
  )
}

// 计时器：进行中显示「(N秒 thinking)」，每秒递增——替代呼吸灯，让进度始终可见
function ThinkingTimer() {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setSec(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const fmt = sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分钟${sec % 60 ? `${sec % 60}秒` : ""}`
  return <span className="text-[12px] text-muted-foreground" style={{ fontFamily: MONO }}>({fmt} thinking)</span>
}

// 单个计划动作的展示（含 diff）
function PlanActionView({ a, login }: { a: PlanAction; login: string }) {
  if (a.kind === "create_repo")
    return <Row icon={<FolderGit2 className="size-3.5" />} label={`新建仓库 ${login}/${a.name}${a.private ? "（私有）" : ""}`} />
  if (a.kind === "delete_file")
    return <Row icon={<Trash2 className="size-3.5" />} label={`删除 ${a.path}`} />
  if (a.kind === "enable_pages")
    return <Row icon={<Rocket className="size-3.5" />} label="开启 GitHub Pages 上线" />
  // write_file
  const isNew = !a.oldContent
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center gap-2 bg-secondary/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        {isNew ? <FilePlus2 className="size-3.5" /> : <FileEdit className="size-3.5" />}
        <span className="truncate font-medium text-foreground/80">{a.path}</span>
        <span className="opacity-70">{isNew ? "新建" : "修改"}</span>
      </div>
      <DiffBody oldContent={a.oldContent} newContent={a.newContent} />
    </div>
  )
}

function Row({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[12px] text-foreground/85">
      <span style={{ color: ACCENT }}>{icon}</span>{label}
    </div>
  )
}

export function CodeConsole({ userId, onExit }: { userId: string; onExit: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [login, setLogin] = useState<string>("")
  const [repos, setRepos] = useState<RepoItem[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [entered, setEntered] = useState(false)   // 进入聊天（选了仓库 或 新建项目模式）

  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<CodeMessage[]>([])
  const [input, setInput] = useState("")
  const [streaming, setStreaming] = useState(false)
  const [tier, setTier] = useState<Tier>("正构")
  const [goalArmed, setGoalArmed] = useState(false)
  const [auto, setAuto] = useState(false)         // 自动模式（不确认直接执行）

  const [pendingPlan, setPendingPlan] = useState<PlanAction[]>([])
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [hiddenRepos, setHiddenRepos] = useState<string[]>([])

  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null)
  const [workspaceDirty, setWorkspaceDirty] = useState(false)  // workspace 有改动，即使 plan 为空也显示 PR 按钮
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [ghMenu, setGhMenu] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    fetch("/api/github/status").then(r => r.json()).then(d => {
      setConnected(!!d.connected); setLogin(d.login ?? "")
    }).catch(() => setConnected(false))
    try {
      const t = localStorage.getItem("code_tier") as Tier | null; if (t && CODE_TIERS.some(x => x.id === t)) setTier(t)
      setAuto(localStorage.getItem("code_auto") === "1")
    } catch {}
  }, [])

  // 从 localStorage 恢复「已隐藏的仓库」列表
  useEffect(() => {
    try { setHiddenRepos(JSON.parse(localStorage.getItem("code_hidden_repos") || "[]")) } catch {}
  }, [])

  function hideRepo(full: string) {
    setHiddenRepos(prev => {
      const next = [...new Set([...prev, full])]
      try { localStorage.setItem("code_hidden_repos", JSON.stringify(next)) } catch {}
      return next
    })
  }
  function resetHiddenRepos() {
    setHiddenRepos([]); try { localStorage.removeItem("code_hidden_repos") } catch {}
  }

  async function loadRepos() {
    if (repos) return
    try { const res = await fetch("/api/github/repos"); const d = await res.json(); setRepos(d.repos ?? []) }
    catch { setRepos([]) }
  }

  async function enterRepo(full: string | null) {
    setRepo(full); setEntered(true); setSessionId(null); setMessages([]); setPendingPlan([]); setApplyError(null); setWorkspaceDirty(false)
    // 恢复该仓库最近一次会话的上下文（退出再进不重置）
    if (full) {
      const sessions = await fetchCodeSessions(full)
      if (sessions.length) {
        const msgs = await fetchCodeMessages(sessions[0].id)
        setSessionId(sessions[0].id); setMessages(msgs)
      }
    }
  }

  // 在当前仓库内开启全新对话（旧对话仍可用 /resume 找回）
  function startNewSession() {
    setSessionId(null); setMessages([]); setPendingPlan([]); setApplyError(null); setWorkspaceDirty(false); setOverlay(null)
  }

  function toggleAuto() { setAuto(v => { const n = !v; try { localStorage.setItem("code_auto", n ? "1" : "0") } catch {} ; return n }) }
  function changeTier(t: Tier) { setTier(t); try { localStorage.setItem("code_tier", t) } catch {}; setOverlay(null) }

  async function disconnect() {
    await fetch("/api/auth/github/disconnect", { method: "POST" }).catch(() => {})
    setConnected(false); setLogin(""); setEntered(false); setRepo(null); setRepos(null); setGhMenu(false)
  }

  // ── 执行计划：直接推送（用户已选）──
  async function applyPlan(plan: PlanAction[], aiMsgId: string) {
    if (!plan.length && !currentTaskId) return  // workspace 模式允许空 plan
    setApplying(true); setApplyError(null)
    try {
      const created = plan.find(a => a.kind === "create_repo") as Extract<PlanAction, { kind: "create_repo" }> | undefined
      // 提取 git commit message：跳过对话碎片行，取第一条有实质内容的行
          const lines = (messages.find(m => m.id === aiMsgId)?.content || "").split("\n").map(l => l.trim()).filter(Boolean)
          const conversationalPrefix = /^(好的|我来|让我|先|这个|那个|嗯|哦|好|可以|收到|明白|懂了|行|OK|ok|OK\.|Yes|yes|Sure|sure|Let|let|I'll|I will)/
          const commitLine = lines.find(l => !conversationalPrefix.test(l)) || lines[0] || ""
          const summary = commitLine.slice(0, 80) || "Claude 代码改动"
      const res = await fetch("/api/code/apply", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, actions: plan, message: summary, taskId: currentTaskId }),
      })
      const data = await res.json()
      if (res.ok) {
        const result = data as ApplyResult
        if (result.created && result.repo) { setRepo(result.repo); setRepos(null) }
        setMessages(prev => prev.map(m => m.id === aiMsgId ? { ...m, result } : m))
        setPendingPlan([])
        setWorkspaceDirty(false)
        // 落库（结果）
        const sid = sessionId
        if (sid) {
          const m = messages.find(x => x.id === aiMsgId)
          if (m) insertCodeMessage(userId, sid, { ...m, plan, result })
        }
      } else setApplyError(data.error ?? "执行失败")
    } catch { setApplyError("网络错误") } finally { setApplying(false) }
  }

  // ── 发送 ──
  async function runSend(text: string, goal: boolean) {
    if (streaming) return
    let sid = sessionId
    if (!sid && repo) { sid = await createCodeSession(userId, repo, text.slice(0, 40) || "未命名"); if (sid) setSessionId(sid) }

    // 自动创建/复用 Agent Task
    let taskId: string | null = currentTaskId
    if (!taskId && repo) {
      try {
        const tres = await fetch("/api/agent/tasks", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ goal: text, mode: "auto", repo }),
        })
        if (tres.ok) { const t = await tres.json(); taskId = t.id; setCurrentTaskId(taskId) }
      } catch {}
    }

    const userMsg: CodeMessage = { id: crypto.randomUUID(), role: "user", content: text }
    const aiId = crypto.randomUUID()
    const aiMsg: CodeMessage = { id: aiId, role: "assistant", content: "", steps: [], plan: [] }
    const history = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }))
    setMessages(prev => [...prev, userMsg, aiMsg])
    setStreaming(true); setApplyError(null); setWorkspaceDirty(false)
    if (sid) insertCodeMessage(userId, sid, userMsg)

    const steps: CodeStep[] = []
    const plan: PlanAction[] = []
    let fullText = ""
    let hadError = false

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch("/api/code/chat", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo, tier, goal, messages: history, taskId }),
      })
      if (!res.ok) { const e = await res.json().catch(() => null); throw new Error(e?.error ?? `请求失败（${res.status}）`) }
      if (!res.body) throw new Error("无响应体")

      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split("\n\n"); buf = parts.pop() ?? ""
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue
          try {
            const d = JSON.parse(line.slice(6))
            if (d.step) { steps.push(d.step); setMessages(prev => prev.map(m => m.id === aiId ? { ...m, steps: [...steps] } : m)) }
            else if (d.plan) { plan.push(d.plan); setMessages(prev => prev.map(m => m.id === aiId ? { ...m, plan: [...plan] } : m)) }
            else if (d.text) { fullText += d.text; setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: fullText } : m)) }
            else if (d.error) { hadError = true; fullText = d.error; setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: d.error, isError: true } : m)) }
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") { hadError = true; setMessages(prev => prev.map(m => m.id === aiId ? { ...m, content: e?.message ?? String(e), isError: true } : m)) }
    } finally {
      setStreaming(false)
      if (sid) insertCodeMessage(userId, sid, { id: aiId, role: "assistant", content: fullText, steps: steps.length ? steps : undefined, plan: plan.length ? plan : undefined, isError: hadError || undefined })
      if (sid) touchCodeSession(sid)
      // 有计划：自动模式直接执行，否则挂起等确认
      if (plan.length && !hadError) {
        if (auto) applyPlan(plan, aiId)
        else setPendingPlan(plan)
      }
      // workspace 模式：即使 plan 为空，也显示 PR 确认按钮
      if (!plan.length && !hadError && taskId) {
        setWorkspaceDirty(true)
      }
    }
  }

  function onSubmit() {
    const text = input.trim()
    if (!text) return
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(" ")
      const arg = rest.join(" ").trim()
      if (cmd === "/model") { setInput(""); setOverlay("model"); return }
      if (cmd === "/memory") { setInput(""); setOverlay("memory"); return }
      if (cmd === "/context") { setInput(""); setOverlay("context"); return }
      if (cmd === "/resume") { setInput(""); setOverlay("resume"); return }
      if (cmd === "/goal") { setInput(""); if (arg) { runSend(arg, true); return } setGoalArmed(true); return }
      if (cmd === "/tasks") { setInput(""); setOverlay("tasks"); return }
      if (cmd === "/new") { setInput(""); startNewSession(); return }
    }
    setInput("")
    const g = goalArmed; setGoalArmed(false)
    runSend(text, g)
  }

  async function loadSession(s: CodeSession) {
    setOverlay(null); setSessionId(s.id); setPendingPlan([])
    setMessages(await fetchCodeMessages(s.id))
  }

  const showCmdHint = input.startsWith("/") && !input.includes(" ")
  const matchedCmds = COMMANDS.filter(c => c.cmd.startsWith(input.trim()))
  const canSend = !streaming && !!input.trim()

  // ════════ 渲染分支 ════════
  if (connected === null)
    return <Shell onExit={onExit}><div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div></Shell>

  if (!connected)
    return (
      <Shell onExit={onExit}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <GitBranch className="size-8" style={{ color: ACCENT }} />
          <p className="text-foreground" style={{ fontFamily: MONO }}>连接你自己的 GitHub，就能让它读写你的仓库</p>
          <button onClick={() => { window.location.href = "/api/auth/github" }}
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: ACCENT, fontFamily: MONO }}>连接 GitHub</button>
        </div>
      </Shell>
    )

  if (!entered)
    return (
      <Shell onExit={onExit} login={login} onGhMenu={() => setGhMenu(true)} ghMenu={ghMenu} onCloseGh={() => setGhMenu(false)} onDisconnect={disconnect}>
        <RepoPicker repos={repos} hidden={hiddenRepos} onLoad={loadRepos} onPick={enterRepo} onHide={hideRepo} onReset={resetHiddenRepos} />
      </Shell>
    )

  // 终端聊天
  return (
    <Shell onExit={() => { setEntered(false); setGhMenu(false) }} login={login} repo={repo} onSwitchRepo={() => { setEntered(false); setGhMenu(false) }}
      onGhMenu={() => setGhMenu(true)} ghMenu={ghMenu} onCloseGh={() => setGhMenu(false)} onDisconnect={disconnect}
      auto={auto} onToggleAuto={toggleAuto}>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 md:px-8" style={{ fontFamily: MONO }}>
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && (
            <p className="text-[12px] text-muted-foreground">
              {repo ? "描述问题或想做的改动，我会自己浏览仓库、定位、动手。" : "告诉我你想做什么（比如「做个番茄钟」），我会新建仓库、写代码、上线。"} 输入 / 看命令。
            </p>
          )}
          {messages.map(m => (
            <MessageView key={m.id} m={m} login={login} streaming={streaming && m.id === messages[messages.length - 1]?.id} />
          ))}
        </div>
      </div>

      {/* 待确认计划条（确认模式）*/}
      {(pendingPlan.length > 0 || workspaceDirty) && !auto && (
        <div className="border-t border-border bg-secondary/40 px-4 py-3 md:px-8">
          <div className="mx-auto max-w-3xl">
            {applyError && <p className="mb-2 text-[12px] leading-relaxed text-destructive">{applyError}</p>}
            <div className="flex items-center gap-3">
            <span className="text-[12px] text-foreground" style={{ fontFamily: MONO }}>{workspaceDirty && !pendingPlan.length ? "Workspace 已修改，等待发布 PR" : planSummary(pendingPlan)}</span>
            <div className="ml-auto flex gap-2">
              <button onClick={() => { setPendingPlan([]); setWorkspaceDirty(false); setApplyError(null) }} disabled={applying}
                className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-secondary">
                <X className="size-3.5" />放弃
              </button>
              <button onClick={() => applyPlan(pendingPlan, [...messages].reverse().find(m => m.role === "assistant")?.id ?? "")} disabled={applying}
                className="flex items-center gap-1 rounded-lg px-3.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ background: ACCENT }}>
                {applying ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                {applying ? <>执行中… <ThinkingTimer /></> : currentTaskId ? "确认并创建 PR" : "确认并执行"}
              </button>
            </div>
            </div>
          </div>
        </div>
      )}
      {applying && auto && (
        <div className="border-t border-border bg-secondary/40 px-4 py-2.5 md:px-8">
          <div className="mx-auto flex max-w-3xl items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />自动执行中… <ThinkingTimer /></div>
        </div>
      )}

      {/* 命令提示 */}
      {showCmdHint && matchedCmds.length > 0 && (
        <div className="border-t border-border px-4 md:px-8">
          <div className="mx-auto max-w-3xl py-1.5">
            {matchedCmds.map(c => (
              <button key={c.cmd} onClick={() => { if (c.cmd === "/goal") { setInput("/goal "); taRef.current?.focus() } else if (c.cmd === "/new") { setInput(""); startNewSession() } else { setInput(""); setOverlay(c.cmd.slice(1) as Overlay) } }}
                className="flex w-full items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-secondary/60">
                <span className="text-[12px] font-medium" style={{ color: ACCENT, fontFamily: MONO }}>{c.cmd}</span>
                <span className="text-[11px] text-muted-foreground">{c.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 输入区：上下两条线 + Enter 键 */}
      <div className="border-y border-border px-4 py-1 md:px-8">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          {goalArmed && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-white" style={{ background: ACCENT }}>目标</span>}
          <span className="shrink-0 select-none" style={{ color: ACCENT, fontFamily: MONO }}>›</span>
          <textarea
            ref={taRef} rows={1} value={input}
            onChange={e => { setInput(e.target.value); const el = e.target; el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 160) + "px" }}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!streaming) onSubmit() } }}
            placeholder={goalArmed ? "描述目标，我会自主多轮完成……" : (repo ? "描述问题，或输入 / 调用命令……" : "想做什么？比如「做个番茄钟」……")}
            className="min-h-0 flex-1 resize-none bg-transparent py-0 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground/60"
            style={{ fontFamily: MONO }}
          />
          {streaming ? (
            <div className="flex items-center gap-2">
              <WorkingDots className="shrink-0" style={{ color: ACCENT }} />
              <ThinkingTimer />
              <button onClick={() => abortRef.current?.abort()} aria-label="停止"
                className="flex h-7 items-center justify-center rounded-lg border border-border bg-secondary px-2.5 text-foreground transition-colors hover:bg-secondary/70">
                <Square className="size-3.5 fill-current" />
              </button>
            </div>
          ) : (
            <button onClick={onSubmit} disabled={!canSend} aria-label="发送"
              title="Enter 发送"
              className={cn("flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[12px] font-medium transition-all", canSend ? "border-transparent text-white" : "border-border text-muted-foreground/40")}
              style={canSend ? { background: ACCENT } : undefined}>
              <CornerDownLeft className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {overlay === "model" && <ModelOverlay tier={tier} onPick={changeTier} onClose={() => setOverlay(null)} />}
      {overlay === "memory" && repo && <MemoryOverlay repo={repo} userId={userId} onClose={() => setOverlay(null)} />}
      {overlay === "memory" && !repo && <SimpleOverlay title="记忆" text="新项目还没有仓库，建好后再来记。" onClose={() => setOverlay(null)} />}
      {overlay === "context" && <ContextOverlay messages={messages} onClose={() => setOverlay(null)} />}
      {overlay === "resume" && repo && <ResumeOverlay repo={repo} onPick={loadSession} onClose={() => setOverlay(null)} />}
      {overlay === "resume" && !repo && <SimpleOverlay title="历史排查" text="新项目模式暂无历史。建好仓库后会自动记录。" onClose={() => setOverlay(null)} />}
      {overlay === "tasks" && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" onClick={() => setOverlay(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md h-[70vh] max-h-[600px] rounded-t-2xl border border-border bg-card sm:rounded-2xl overflow-hidden">
            <AgentTasksPanel onClose={() => setOverlay(null)} />
          </div>
        </div>
      )}
    </Shell>
  )
}

function planSummary(plan: PlanAction[]): string {
  const c = plan.filter(a => a.kind === "create_repo").length
  const w = plan.filter(a => a.kind === "write_file").length
  const d = plan.filter(a => a.kind === "delete_file").length
  const p = plan.some(a => a.kind === "enable_pages")
  const parts: string[] = []
  if (c) parts.push(`新建 ${c} 个仓库`)
  if (w) parts.push(`写入 ${w} 个文件`)
  if (d) parts.push(`删除 ${d} 个文件`)
  if (p) parts.push("上线")
  return parts.join(" · ") || "改动"
}

// ── 外壳：跟随主题的全屏 + 顶部导航条 ──
function Shell({ children, onExit, repo, login, onSwitchRepo, onGhMenu, ghMenu, onCloseGh, onDisconnect, auto, onToggleAuto }: {
  children: React.ReactNode
  onExit: () => void
  repo?: string | null
  login?: string
  onSwitchRepo?: () => void
  onGhMenu?: () => void
  ghMenu?: boolean
  onCloseGh?: () => void
  onDisconnect?: () => void
  auto?: boolean
  onToggleAuto?: () => void
}) {
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background paper-grain">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 md:px-8">
        <button onClick={onExit} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
          <ChevronLeft className="size-4" />退出
        </button>
        <span className="text-[12px] tracking-[0.25em]" style={{ color: ACCENT, fontFamily: MONO }}>CODE</span>

        <div className="ml-auto flex items-center gap-2">
          {onToggleAuto && (
            <button onClick={onToggleAuto} title="自主模式" className="rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-secondary" style={{ fontFamily: MONO, color: auto ? ACCENT : undefined, borderColor: auto ? ACCENT : undefined }}>
              {auto ? "自动" : "确认"}
            </button>
          )}
          {repo !== undefined && repo && (
            <button onClick={onSwitchRepo} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-foreground/80 transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
              <GitBranch className="size-3.5" style={{ color: ACCENT }} />{repo}
            </button>
          )}
          {repo !== undefined && !repo && login !== undefined && (
            <span className="rounded-md px-2 py-1 text-[12px] text-muted-foreground" style={{ fontFamily: MONO }}>新项目</span>
          )}
          {/* GitHub 账号入口 */}
          {login !== undefined && (
            <div className="relative">
              <button onClick={onGhMenu} className="flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-secondary" style={{ fontFamily: MONO }}>
                {login ? `@${login}` : "GitHub"}<ChevronDown className="size-3" />
              </button>
              {ghMenu && (
                <>
                  <button className="fixed inset-0 z-10 cursor-default" aria-label="关闭" onClick={onCloseGh} />
                  <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
                    <a href="https://github.com/settings/applications" target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2.5 text-[12px] text-foreground transition-colors hover:bg-secondary">
                      <ExternalLink className="size-3.5" />管理授权
                    </a>
                    <button onClick={onDisconnect} className="flex w-full items-center gap-2 border-t border-border/60 px-3 py-2.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10">
                      <X className="size-3.5" />断开 GitHub
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}

// ── 单条消息 ──
function MessageView({ m, login, streaming }: { m: CodeMessage; login: string; streaming: boolean }) {
  if (m.role === "user")
    return (
      <div className="border-t border-b py-1" style={{ borderColor: ACCENT }}>
        <span className="whitespace-pre-wrap break-words text-[13.5px] leading-5 text-foreground">{m.content}</span>
      </div>
    )

  // 步骤折叠：read* / list* 只计数，其余展示
  const steps = m.steps ?? []
  const readCount = steps.filter(s => s.kind === "read" || s.kind === "list").length
  const notableSteps = steps.filter(s => s.kind !== "read" && s.kind !== "list")
  const [stepsOpen, setStepsOpen] = useState(false)

  return (
    <div className="space-y-1.5">
      {/* 流式进行中 + 还没正文：点阵 + 计时合并 */}
      {streaming && !m.content && (
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <WorkingDots className="shrink-0" style={{ color: ACCENT }} />
          <ThinkingTimer />
        </div>
      )}
      {m.content && !m.isError && (
        <div className="text-[13.5px] leading-[1.7] text-foreground/90" style={{ fontFamily: MONO }}>
          <ReactMarkdown
            remarkPlugins={[remarkMath, remarkGfm]}
            rehypePlugins={[rehypeKatex]}
            components={{
              p: ({ children }) => <p className="break-words mb-2 [overflow-wrap:anywhere]">{children}</p>,
              a: ({ children, href }) => <a href={href} className="break-all underline underline-offset-4" style={{ color: ACCENT }} target="_blank" rel="noreferrer">{children}</a>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              em: ({ children }) => <em className="italic">{children}</em>,
              code: ({ className, children, ...props }) => {
                const isInline = !className
                if (isInline) return <code className="rounded bg-secondary/60 px-1 py-0.5 text-[12px]" {...props}>{children}</code>
                return <code className="block overflow-x-auto rounded bg-secondary/40 px-3 py-2 text-[12px] leading-relaxed" {...props}>{children}</code>
              },
              pre: ({ children }) => <pre className="max-w-full overflow-x-auto rounded bg-secondary/40 p-3 mb-2 text-[12px] border border-border/30">{children}</pre>,
              ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-0.5">{children}</ul>,
              ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-0.5">{children}</ol>,
              li: ({ children }) => <li className="mb-0.5">{children}</li>,
              blockquote: ({ children }) => <blockquote className="border-l-2 pl-3 mb-2 italic opacity-80" style={{ borderColor: ACCENT }}>{children}</blockquote>,
              table: ({ children }) => (
                <div className="overflow-x-auto mb-3 rounded-lg border border-border/50">
                  <table className="min-w-full border-collapse text-[12px]">{children}</table>
                </div>
              ),
              thead: ({ children }) => <thead className="border-b border-border/50 bg-secondary/30">{children}</thead>,
              th: ({ children }) => <th className="border-r border-border/30 px-3 py-2 text-left font-semibold last:border-r-0">{children}</th>,
              tbody: ({ children }) => <tbody className="[&_tr:nth-child(even)]:bg-secondary/20">{children}</tbody>,
              td: ({ children }) => <td className="border-r border-border/20 px-3 py-1.5 last:border-r-0">{children}</td>,
              h1: ({ children }) => <h1 className="text-[15px] font-bold mb-2 mt-3">{children}</h1>,
              h2: ({ children }) => <h2 className="text-[14px] font-semibold mb-1.5 mt-2.5">{children}</h2>,
              h3: ({ children }) => <h3 className="text-[13.5px] font-semibold mb-1 mt-2">{children}</h3>,
              hr: () => <hr className="my-3 border-border/40" />,
            }}
          >
            {stripToolMarkup(m.content)}
          </ReactMarkdown>
        </div>
      )}
      {m.content && m.isError && (
        <p className="whitespace-pre-wrap break-words text-[13.5px] leading-[1.7] text-destructive">{m.content}</p>
      )}
      {/* 操作摘要（步骤折叠） */}
      {steps.length > 0 && (
        <div className="mt-1">
          <button
            onClick={() => setStepsOpen(v => !v)}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground"
            style={{ fontFamily: MONO }}
          >
            <ChevronDown className={cn("size-3 transition-transform", stepsOpen && "rotate-180")} />
            {readCount > 0 && <span>已读 {readCount} 文件{notableSteps.length > 0 && " · "}</span>}
            {notableSteps.map((s, i) => (
              <span key={i}>{s.label}{i < notableSteps.length - 1 && " · "}</span>
            ))}
          </button>
          {stepsOpen && (
            <div className="mt-1 space-y-0.5 pl-5">
              {steps.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground/60">
                  <span className="shrink-0" style={{ color: s.kind === "edit" || s.kind === "repo" || s.kind === "deploy" ? ACCENT : "var(--muted-foreground)", opacity: 0.5 }}>·</span>
                  {s.label}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {m.plan?.map((a, i) => <PlanActionView key={i} a={a} login={login} />)}
      {m.result && <ResultCard r={m.result} />}
    </div>
  )
}

function ResultCard({ r }: { r: ApplyResult }) {
  const isPR = r.mode === "workspace_pr"
  return (
    <div className="mt-1 space-y-1 rounded-lg border px-3 py-2.5 text-[12px]" style={{ borderColor: ACCENT, background: "color-mix(in oklab, " + ACCENT + " 8%, transparent)" }}>
      <div className="flex items-center gap-2 font-medium text-foreground">
        <Check className="size-3.5" style={{ color: ACCENT }} />
        {isPR ? "已创建 Pull Request" : "已提交并推送"}{r.created ? "（新仓库已创建）" : ""}
      </div>
      {isPR && r.pullRequestUrl && (
        <a href={r.pullRequestUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-muted-foreground underline-offset-2 hover:underline">
          <ExternalLink className="size-3" />查看 Pull Request #{r.pullRequestNumber ?? "?"}
        </a>
      )}
      {r.repoUrl && !isPR && <a href={r.repoUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-muted-foreground underline-offset-2 hover:underline"><ExternalLink className="size-3" />在 GitHub 查看仓库</a>}
      {r.pagesUrl && <a href={r.pagesUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 underline-offset-2 hover:underline" style={{ color: ACCENT }}><Rocket className="size-3" />已上线：{r.pagesUrl}</a>}
      {r.message && <p className="text-muted-foreground/60 italic">{r.message}</p>}
    </div>
  )
}

// ── 仓库选择（含新建项目入口）──
function RepoPicker({ repos, hidden, onLoad, onPick, onHide, onReset }: { repos: RepoItem[] | null; hidden: string[]; onLoad: () => void; onPick: (full: string | null) => void; onHide: (full: string) => void; onReset: () => void }) {
  useEffect(() => { if (repos === null) onLoad() }, [repos, onLoad])
  const visible = repos?.filter(r => !hidden.includes(r.full_name)) ?? null
  const hiddenCount = repos && visible ? repos.length - visible.length : 0
  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
      <div className="mx-auto max-w-2xl space-y-2">
        <button onClick={() => onPick(null)} className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-secondary/50" style={{ borderColor: ACCENT }}>
          <Plus className="size-4 shrink-0" style={{ color: ACCENT }} />
          <span className="text-[13px] font-medium text-foreground" style={{ fontFamily: MONO }}>从零做个新项目（我来建仓库）</span>
        </button>
        <p className="px-1 pt-2 text-[12px] text-muted-foreground" style={{ fontFamily: MONO }}>或选一个已有仓库改：</p>
        {visible === null ? (
          <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">没有可显示的仓库</p>
        ) : visible.map(r => (
          <div key={r.full_name} className="group flex w-full items-center gap-2 rounded-lg border border-border px-4 py-2.5 transition-colors hover:bg-secondary/50">
            <button onClick={() => onPick(r.full_name)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <GitBranch className="size-4 shrink-0" style={{ color: ACCENT }} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground" style={{ fontFamily: MONO }}>{r.full_name}</span>
                {r.description && <span className="block truncate text-[11px] text-muted-foreground">{r.description}</span>}
              </span>
              {r.private && <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">私有</span>}
            </button>
            <button onClick={() => onHide(r.full_name)} aria-label="从列表移除" title="从列表移除（不会删除 GitHub 上的真实仓库）"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-secondary hover:text-destructive group-hover:opacity-100">
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
        {hiddenCount > 0 && (
          <button onClick={onReset} className="w-full pt-2 text-center text-[11px] text-muted-foreground transition-colors hover:text-foreground" style={{ fontFamily: MONO }}>
            已隐藏 {hiddenCount} 个 · 点此恢复全部
          </button>
        )}
      </div>
    </div>
  )
}

// ── 覆盖层 ──
function OverlayShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  if (typeof document === "undefined") return null
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div onClick={e => e.stopPropagation()} className="relative w-full max-w-md rounded-t-2xl border border-border bg-card p-4 sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[13px] font-medium text-foreground" style={{ fontFamily: MONO }}>{title}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

function SimpleOverlay({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return <OverlayShell title={title} onClose={onClose}><p className="text-[12px] text-muted-foreground">{text}</p></OverlayShell>
}

function ModelOverlay({ tier, onPick, onClose }: { tier: Tier; onPick: (t: Tier) => void; onClose: () => void }) {
  return (
    <OverlayShell title="切换模型" onClose={onClose}>
      <div className="space-y-1.5">
        {CODE_TIERS.map(t => (
          <button key={t.id} onClick={() => onPick(t.id)} className="flex w-full items-center gap-3 rounded-lg border px-4 py-2.5 text-left transition-colors hover:bg-secondary/60"
            style={{ borderColor: tier === t.id ? ACCENT : "var(--border)" }}>
            <span className="flex-1 text-[13px] text-foreground" style={{ fontFamily: MONO }}>{t.label}</span>
            <span className="text-[11px] text-muted-foreground">{t.desc}</span>
            {tier === t.id && <Check className="size-4" style={{ color: ACCENT }} />}
          </button>
        ))}
      </div>
    </OverlayShell>
  )
}

function MemoryOverlay({ repo, userId, onClose }: { repo: string; userId: string; onClose: () => void }) {
  const [mems, setMems] = useState<CodeMemory[] | null>(null)
  const [adding, setAdding] = useState("")
  useEffect(() => { fetchCodeMemories(repo).then(setMems) }, [repo])
  async function add() { const c = adding.trim(); if (!c) return; const m = await insertCodeMemory(userId, repo, c); if (m) setMems(prev => [...(prev ?? []), m]); setAdding("") }
  async function del(id: string) { setMems(prev => (prev ?? []).filter(m => m.id !== id)); deleteCodeMemory(id) }
  return (
    <OverlayShell title={`本仓库记忆 · ${repo}`} onClose={onClose}>
      <p className="mb-2 text-[11px] text-muted-foreground">只属于这个仓库，与系统记忆、其它仓库相互隔离。</p>
      <div className="max-h-[40vh] space-y-1.5 overflow-y-auto">
        {mems === null ? <div className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
          : mems.length === 0 ? <p className="py-3 text-center text-[12px] text-muted-foreground">还没有记忆</p>
          : mems.map(m => (
            <div key={m.id} className="flex items-start gap-2 rounded-lg bg-secondary/50 px-3 py-2">
              <span className="flex-1 text-[12px] leading-relaxed text-foreground/90">{m.content}</span>
              <button onClick={() => del(m.id)} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === "Enter") add() }} placeholder="手动添加一条记忆…"
          className="flex-1 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-[12px] text-foreground outline-none" />
        <button onClick={add} className="rounded-lg px-3 py-2 text-white" style={{ background: ACCENT }}><Plus className="size-4" /></button>
      </div>
    </OverlayShell>
  )
}

function ContextOverlay({ messages, onClose }: { messages: CodeMessage[]; onClose: () => void }) {
  const chars = messages.reduce((s, m) => s + m.content.length + (m.plan?.reduce((a, p) => a + (p.kind === "write_file" ? p.newContent.length : 0), 0) ?? 0), 0)
  const approx = Math.round(chars / 3)
  const max = 128_000
  const pct = Math.min(100, (approx / max) * 100)
  return (
    <OverlayShell title="上下文用量" onClose={onClose}>
      <div className="space-y-3" style={{ fontFamily: MONO }}>
        <div className="flex justify-between text-[12px]"><span className="text-muted-foreground">消息条数</span><span className="text-foreground">{messages.length}</span></div>
        <div className="flex justify-between text-[12px]"><span className="text-muted-foreground">约 token</span><span className="text-foreground">{approx.toLocaleString()} / {max.toLocaleString()}</span></div>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: ACCENT }} /></div>
        <p className="text-[11px] text-muted-foreground">估算值（按字符粗略折算），仅供参考。</p>
      </div>
    </OverlayShell>
  )
}

function ResumeOverlay({ repo, onPick, onClose }: { repo: string; onPick: (s: CodeSession) => void; onClose: () => void }) {
  const [sessions, setSessions] = useState<CodeSession[] | null>(null)
  useEffect(() => { fetchCodeSessions(repo).then(setSessions) }, [repo])
  return (
    <OverlayShell title={`历史排查 · ${repo}`} onClose={onClose}>
      <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
        {sessions === null ? <div className="flex justify-center py-4 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
          : sessions.length === 0 ? <p className="py-3 text-center text-[12px] text-muted-foreground">还没有历史会话</p>
          : sessions.map(s => (
            <button key={s.id} onClick={() => onPick(s)} className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:bg-secondary/60">
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground" style={{ fontFamily: MONO }}>{s.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{s.date}</span>
            </button>
          ))}
      </div>
    </OverlayShell>
  )
}
